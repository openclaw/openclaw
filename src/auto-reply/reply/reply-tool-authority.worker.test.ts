import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { acceptCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import * as capabilityReads from "../../agents/subagents/spawn/subagent-session-store.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import {
  projectionLane,
  targetDiscoveryLane,
} from "../../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { bindSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import * as sessionReaders from "../../gateway/session-utils-store-worker.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { closeAgentWorkAdmissions } from "../../sessions/session-controller.lifecycle.js";
import {
  acknowledgeReplySessionTransition,
  captureReplyOperationSessionReader,
  getReplyOperationSessionReader,
} from "../../sessions/session-controller.session-reader.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage,
} from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createQueueTestRun, toolAuthorityOverlay } from "./reply-tool-authority.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

afterEach(() => {
  testing.resetSessionControllerForTest();
  vi.restoreAllMocks();
});

const executionKey = "agent:main:authority-execution";
const policyKey = "agent:main:authority-policy";

function withState(run: (state: OpenClawTestState, config: OpenClawConfig) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, (state) => run(state, {}));
}

function seed(sessionKey: string, entry: Partial<SessionEntry>, agentId = "main") {
  return upsertSessionEntryCore({ agentId, sessionKey }, { updatedAt: 1, ...entry });
}

function makeRun(overrides: Partial<ReturnType<typeof createQueueTestRun>["run"]>) {
  const run = createQueueTestRun({ prompt: "authority" });
  Object.assign(run.run, { agentId: "main" }, overrides);
  return run;
}

async function prepareEmbedded(
  state: OpenClawTestState,
  config: OpenClawConfig,
  runId: string,
  overrides: Partial<Parameters<typeof withPreparedEmbeddedRunToolAuthority>[1]> = {},
  boundary = "worker-authority-test",
) {
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary },
    },
  });
  try {
    const admittedRunContext = await admission.admit("embedded", boundary);
    const attempt = {
      sessionId: "execution",
      sessionKey: executionKey,
      runId,
      agentId: "main",
      config,
      sessionFile: "/tmp/authority-worker.jsonl",
      workspaceDir: state.workspaceDir,
      provider: "openai",
      modelId: "gpt-test",
      senderIsOwner: true,
      messageProvider: "webchat",
      ...overrides,
    };
    return {
      admission,
      submit: (effect: () => Promise<string>) =>
        withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, effect),
    };
  } catch (error) {
    admission.close();
    throw error;
  }
}

it("prepares embedded tool authority without caller-thread SQL and refuses a closing owner", async () => {
  await withState(async (state, config) => {
    setRuntimeConfigSnapshot(config);
    await seed(policyKey, { sessionId: "policy", sandboxMode: "off" });
    const { admission, submit } = await prepareEmbedded(state, config, "worker-authority", {
      sandboxSessionKey: policyKey,
    });
    const effects = vi.fn(async () => "admitted");
    const calls = observeMainThreadSql();
    try {
      await expect(submit(effects)).resolves.toBe("admitted");
      calls.expectIdle();
      const pending = submit(effects);
      admission.close();
      await expect(pending).rejects.toThrow();
      expect(effects).toHaveBeenCalledTimes(1);
      calls.expectIdle();
    } finally {
      admission.close();
    }
  });
});

it.each(["main", "policy", "borrowed"] as const)(
  "retains the %s-agent source while rereading changed sandbox policy before steering",
  async (policyAgent) => {
    await withState(async (state) => {
      const config: OpenClawConfig = {
        agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {}, policy: {} } },
        tools: { sandbox: { tools: { deny: ["exec"] } } },
      };
      setRuntimeConfigSnapshot(config);
      const policyAgentId = policyAgent === "borrowed" ? "main" : policyAgent;
      const classificationKey =
        policyAgent === "borrowed" ? executionKey : `agent:${policyAgent}:authority-policy`;
      await seed(classificationKey, { sessionId: "policy", sandboxMode: "off" }, policyAgentId);
      // Settle setup maintenance before retaining the readers used across the policy change.
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      const run = makeRun({
        sessionKey: executionKey,
        runtimePolicySessionKey: classificationKey,
        config,
      });
      const admission =
        policyAgent === "borrowed"
          ? await loadSessionEntryForAdmission({
              agentId: "main",
              sessionKey: classificationKey,
              env: state.env,
            })
          : undefined;
      const reader =
        admission && "kind" in admission.databaseClaim ? admission.databaseClaim.reader : undefined;
      if (admission && !reader) {
        await admission.databaseClaim.release();
        throw new Error("Expected admitted session reader");
      }
      const discovery = vi.spyOn(sessionReaders, "prepareGatewaySessionEntryReadOnlyInWorker");
      const snapshot = prepareReplyToolAuthority(run, undefined, () => reader);
      try {
        const operation = createTestReplyOperation({
          sessionKey: executionKey,
          sessionId: run.run.sessionId,
        });
        let initialEntries = 0;
        const initialReads = [projectionLane, targetDiscoveryLane].map(({ pool }) => {
          const runRequest = pool.run.bind(pool);
          return vi.spyOn(pool, "run").mockImplementation(async (...args) => {
            const reply = await runRequest(...args);
            if (
              reply.ok &&
              typeof reply.value === "object" &&
              reply.value !== null &&
              "kind" in reply.value &&
              reply.value.kind === "session-exact-entries"
            ) {
              initialEntries++;
            }
            return reply;
          });
        });
        try {
          await operation.bindToolAuthoritySnapshotAsync(snapshot);
          expect(initialEntries).toBe(policyAgent === "borrowed" ? 0 : 1);
        } finally {
          initialReads.forEach((read) => read.mockRestore());
        }
        const admitted = await operation.bindToolAuthorityRouteAsync(run.run);
        await upsertSessionEntryCore(
          { agentId: policyAgentId, sessionKey: classificationKey, env: state.env },
          { sandboxMode: undefined },
        );
        const calls = observeMainThreadSql();
        discovery.mockClear();
        expect(() => snapshot.fingerprint(run.run)).toThrow(
          "Tool authority classification session changed",
        );
        expect(await snapshot.fingerprintAsync(run.run)).not.toBe(admitted);
        if (reader) {
          expect(discovery).not.toHaveBeenCalled();
        }
        discovery.mockClear();
        await expect(
          operation.projectToolAuthorityFingerprintAsync(toolAuthorityOverlay(run)),
        ).resolves.toBeUndefined();
        calls.expectIdle();
        expect(discovery).not.toHaveBeenCalled();
        if (admission) {
          await admission.databaseClaim.release();
          discovery.mockClear();
          await expect(snapshot.fingerprintAsync(run.run)).rejects.toThrow();
          expect(discovery).not.toHaveBeenCalled();
        }
      } finally {
        snapshot.close();
        await admission?.databaseClaim.release();
      }
    });
  },
);

it.each(["execution", "separate"] as const)(
  "retains frozen %s-policy authority across an acknowledged compaction reader handoff",
  async (classification) => {
    await withState(async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: executionKey,
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      };
      const original = {
        sessionId: "execution",
        lifecycleRevision: "original",
        updatedAt: Date.now(),
      };
      await upsertSessionEntryCore(scope, original);
      if (classification === "separate") {
        await upsertSessionEntryCore(
          { ...scope, sessionKey: policyKey },
          { sessionId: "policy", lifecycleRevision: "policy", updatedAt: Date.now() },
        );
      }
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      const admitted = await admitReplyTurn({
        ...scope,
        sessionId: original.sessionId,
        kind: "visible",
        resetTriggered: false,
      });
      if (admitted.status !== "owned") {
        throw new Error("Fixture requires retained reply admission");
      }
      const controller = getSessionControllerEntryForOperation(admitted.operation);
      const run = makeRun({
        workspaceDir: state.workspaceDir,
        sessionKey: executionKey,
        sessionId: original.sessionId,
        sessionFile: executionKey,
        runtimePolicySessionKey: classification === "separate" ? policyKey : executionKey,
        config: {},
      });
      const reader = getReplyOperationSessionReader(admitted.operation);
      if (!reader) {
        throw new Error("Fixture requires an execution reader");
      }
      const snapshot = prepareReplyToolAuthority(
        run,
        undefined,
        captureReplyOperationSessionReader(admitted.operation),
      );
      const independent = prepareReplyToolAuthority(run);
      const discovery = vi.spyOn(sessionReaders, "prepareGatewaySessionEntryReadOnlyInWorker");
      try {
        await admitted.operation.bindToolAuthoritySnapshotAsync(snapshot);
        const fingerprint = await admitted.operation.bindToolAuthorityRouteAsync(run.run);
        await expect(independent.fingerprintAsync(run.run)).resolves.toBe(fingerprint);
        const accepted = await acceptCompactionSuccessor({
          currentTarget: { ...scope, sessionId: original.sessionId },
          expectedEntry: { ...original, activeWriterRunId: undefined },
          assertActive: () => admitted.operation.abortSignal.throwIfAborted(),
          result: {
            ok: true,
            compacted: true,
            result: { sessionId: "compacted-execution", tokensBefore: 0 },
          },
        });
        if (!accepted.admissionTransition) {
          throw new Error("Compaction must acknowledge the committed identity transition");
        }
        await acknowledgeReplySessionTransition(admitted.operation, accepted.admissionTransition);
        admitted.operation.updateSessionId(accepted.sessionId);
        expect(() => reader.assertCurrent()).toThrow(/released/u);
        for (const authority of [independent, snapshot]) {
          const refreshed = expect(authority.fingerprintAsync(run.run));
          if (classification === "separate") {
            await refreshed.resolves.toBe(fingerprint);
          } else {
            await refreshed.rejects.toThrow("Tool authority classification source changed");
          }
        }
        if (classification === "separate") {
          await expect(admitted.operation.bindToolAuthorityRouteAsync(run.run)).resolves.toBe(
            fingerprint,
          );
        }
        admitted.operation.complete();
        await waitForReplyRunSuccessorAdmission(executionKey, null, { target: controller.target });
        discovery.mockClear();
        await expect(snapshot.fingerprintAsync(run.run)).rejects.toThrow();
        expect(discovery).not.toHaveBeenCalled();
      } finally {
        independent.close();
        admitted.operation.complete();
        await waitForReplyRunSuccessorAdmission(executionKey, null, { target: controller.target });
      }
    });
  },
);

it.each([
  "unrelated deletion",
  "model fallback",
  "revoked policy",
  "reassigned session",
  "rotated lifecycle",
  "reparented session",
  "changed sandbox",
  "changed exec host",
  "changed delegation",
  "deleted requester",
] as const)(
  "rechecks reply capability authority after an await during %s before queueMessage",
  async (change) => {
    await withState(async (state, config) => {
      setRuntimeConfigSnapshot(config);
      const sessionKey = "agent:main:subagent:replay-requester";
      const sessionId = "replay-requester";
      const scope = { agentId: "main", sessionKey };
      await seed(sessionKey, {
        sessionId,
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["read", "exec"],
      });
      const projection = await createSessionRowProjection({ cfg: config });
      const run = makeRun({
        workspaceDir: state.workspaceDir,
        sessionKey,
        sessionId,
        config,
      });
      const snapshot = prepareReplyToolAuthority(run);
      let releaseIngress: (() => void) | undefined;
      try {
        await projection.ensureMaterialized();
        const context = bindSessionRowProjection(createDirectChatContext({}), () => projection);
        await withPluginRuntimeGatewayContextResolver(
          () => context,
          async () => {
            const operation = createTestReplyOperation({ sessionKey, sessionId });
            await operation.bindToolAuthoritySnapshotAsync(snapshot);
            await operation.bindToolAuthorityRouteAsync(run.run);
            const queueMessage = vi.fn(async () => {});
            operation.attachBackend({
              kind: "embedded",
              cancel: vi.fn(),
              isStreaming: () => true,
              queueMessage,
            });
            operation.setPhase("running");
            const prepare = capabilityReads.prepareSessionCapabilityRead;
            let interleaved = false;
            vi.spyOn(capabilityReads, "prepareSessionCapabilityRead").mockImplementation(
              async (read) => {
                const prepared = await prepare(read);
                if (!interleaved) {
                  if (change === "unrelated deletion" || change === "deleted requester") {
                    const deletedAgent = change === "unrelated deletion" ? "deleting" : "main";
                    releaseIngress = closeAgentWorkAdmissions({
                      agentId: deletedAgent,
                      env: state.env,
                      reason: new Error("Agent deletion is draining active work"),
                    });
                    beginAgentDeletionJournal(
                      {
                        agentId: deletedAgent,
                        operationId: "capability-replay",
                        agentDir: state.agentDir(deletedAgent),
                        workspaceDir: state.workspaceDir,
                        sessionsDir: state.sessionsDir(deletedAgent),
                        databasePaths: [],
                        deleteFiles: false,
                      },
                      { env: state.env },
                    );
                  } else {
                    const patches = {
                      "model fallback": {
                        model: "fallback-model",
                        modelProvider: "fallback-provider",
                      },
                      "revoked policy": { inheritedToolDeny: ["exec"] },
                      "reassigned session": { sessionId: "replacement-requester" },
                      "rotated lifecycle": { lifecycleRevision: "replacement-lifecycle" },
                      "reparented session": { spawnedBy: "agent:main:other-parent" },
                      "changed sandbox": { sandboxMode: "all" },
                      "changed exec host": { execHost: "gateway" },
                      "changed delegation": {
                        delegatedToolPolicy: {
                          requesterSessionKey: "agent:main:main",
                          targetAgentId: "main",
                          deny: ["exec"],
                          requesterDeny: ["exec"],
                        },
                      },
                    } satisfies Record<typeof change, Partial<SessionEntry>>;
                    await patchSessionEntryCore(scope, () => patches[change]);
                  }
                  interleaved = true;
                }
                return prepared;
              },
            );
            const result = await queueCurrentReplyRunMessage(sessionId, "continue", {
              isInboundUserMessage: true,
              toolAuthorityOverlay: toolAuthorityOverlay(run),
            });
            expect(interleaved).toBe(true);
            if (change === "unrelated deletion" || change === "model fallback") {
              expect(result).toEqual({ status: "accepted" });
              expect(queueMessage).toHaveBeenCalledOnce();
            } else {
              expect(result).toEqual({ status: "rejected", reason: "tool_authority_mismatch" });
              expect(queueMessage).not.toHaveBeenCalled();
            }
          },
        );
      } finally {
        releaseIngress?.();
        snapshot.close();
        projection.dispose();
      }
    });
  },
);

it("propagates a lineage database failure before submitTurn", async () => {
  await withState(async (state, config) => {
    setRuntimeConfigSnapshot(config);
    const sessionKey = "agent:main:subagent:unreadable-lineage";
    const sessionId = "unreadable-lineage";
    const runId = "worker-authority-database-failure";
    await seed(sessionKey, {
      sessionId,
      spawnedBy: "agent:broken:subagent:parent",
      subagentRole: "orchestrator",
      inheritedToolPolicyVersion: 1,
    });
    const { admission, submit } = await prepareEmbedded(
      state,
      config,
      runId,
      { sessionId, sessionKey, sessionFile: state.statePath("unreadable-lineage.jsonl") },
      "database-failure-test",
    );
    try {
      const brokenPath = resolveOpenClawAgentSqlitePath({ agentId: "broken", env: state.env });
      fs.mkdirSync(path.dirname(brokenPath), { recursive: true });
      fs.writeFileSync(brokenPath, "not a SQLite database");
      const submitTurn = vi.fn(async () => "submitted");
      await expect(submit(submitTurn)).rejects.toThrow(/not a database/i);
      expect(submitTurn).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  });
});
