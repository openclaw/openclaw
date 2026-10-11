import { afterEach, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { acceptCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import {
  projectionLane,
  targetDiscoveryLane,
} from "../../config/sessions/session-transcript-worker-resources.js";
import * as sessionReaders from "../../gateway/session-utils-store-worker.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { waitForReplyRunSuccessorAdmission } from "./reply-run-registry.js";
import {
  acknowledgeReplySessionTransition,
  captureReplyOperationSessionReader,
  getReplyOperationSessionReader,
} from "./reply-run-registry.state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

const executionKey = "agent:main:authority-execution";
const policyKey = "agent:main:authority-policy";

it("prepares embedded tool authority without caller-thread SQL and refuses a closing owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: policyKey },
      { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
    );
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("worker-authority"),
      facts: {
        agentId: "main",
        runId: "worker-authority",
        ingress: { kind: "system", state: "present", boundary: "worker-authority-test" },
      },
    });
    try {
      const admittedRunContext = await admission.admit("embedded", "worker-authority-test");
      const attempt = {
        sessionId: "execution",
        sessionKey: executionKey,
        runId: "worker-authority",
        agentId: "main",
        config: {},
        sessionFile: "/tmp/authority-worker.jsonl",
        workspaceDir: state.workspaceDir,
        provider: "openai",
        modelId: "gpt-test",
        sandboxSessionKey: policyKey,
        senderIsOwner: true,
        messageProvider: "webchat",
      };
      const effects = vi.fn(async () => "admitted");
      const calls = observeMainThreadSql();
      try {
        await expect(
          withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, effects),
        ).resolves.toBe("admitted");
        calls.expectIdle();
        const pending = withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          attempt,
          undefined,
          effects,
        );
        admission.close();
        await expect(pending).rejects.toThrow();
        expect(effects).toHaveBeenCalledTimes(1);
        calls.expectIdle();
      } finally {
        calls.restore();
      }
    } finally {
      admission.close();
    }
  });
});

it.each(["main", "policy", "borrowed"] as const)(
  "retains the %s-agent source while rereading changed sandbox policy before steering",
  async (policyAgent) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const policyAgentId = policyAgent === "borrowed" ? "main" : policyAgent;
      const classificationKey =
        policyAgent === "borrowed" ? executionKey : `agent:${policyAgent}:authority-policy`;
      await upsertSessionEntryCore(
        { agentId: policyAgentId, sessionKey: classificationKey },
        { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
      );
      // Settle setup maintenance before retaining the readers used across the policy change.
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      const run = createQueueTestRun({ prompt: "authority" });
      Object.assign(run.run, {
        sessionKey: executionKey,
        runtimePolicySessionKey: classificationKey,
        agentId: "main",
        config: {
          agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {}, policy: {} } },
          tools: { sandbox: { tools: { deny: ["exec"] } } },
        },
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
          // The borrowed admission read already warmed the entry facts.
          expect(initialEntries).toBe(policyAgent === "borrowed" ? 0 : 1);
        } finally {
          for (const read of initialReads) {
            read.mockRestore();
          }
        }
        const admitted = await operation.bindToolAuthorityRouteAsync(run.run);
        await upsertSessionEntryCore(
          { agentId: policyAgentId, sessionKey: classificationKey, env: state.env },
          { sandboxMode: undefined },
        );
        const calls = observeMainThreadSql();
        try {
          discovery.mockClear();
          expect(await snapshot.fingerprintAsync(run.run)).not.toBe(admitted);
          if (reader) {
            expect(discovery).not.toHaveBeenCalled();
          }
          discovery.mockClear();
          await expect(
            operation.projectToolAuthorityFingerprintAsync({
              senderIsOwner: run.run.senderIsOwner === true,
              disableTools: false,
              traceAuthorized: false,
            }),
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
          calls.restore();
        }
      } finally {
        discovery.mockRestore();
        await admission?.databaseClaim.release();
      }
    });
  },
);

it.each(["execution", "separate"] as const)(
  "retains frozen %s-policy authority across an acknowledged compaction reader handoff",
  async (classification) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      const run = createQueueTestRun({ prompt: "authority after compaction" });
      Object.assign(run.run, {
        agentId: "main",
        sessionKey: executionKey,
        sessionId: original.sessionId,
        sessionFile: executionKey,
        workspaceDir: state.workspaceDir,
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
      // Main's independent policy lookup already refuses a changed classification identity.
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
        if (classification === "separate") {
          await expect(independent.fingerprintAsync(run.run)).resolves.toBe(fingerprint);
          await expect(snapshot.fingerprintAsync(run.run)).resolves.toBe(fingerprint);
          await expect(admitted.operation.bindToolAuthorityRouteAsync(run.run)).resolves.toBe(
            fingerprint,
          );
        } else {
          await expect(independent.fingerprintAsync(run.run)).rejects.toThrow(
            "Tool authority classification source changed",
          );
          await expect(snapshot.fingerprintAsync(run.run)).rejects.toThrow(
            "Tool authority classification source changed",
          );
        }
        admitted.operation.complete();
        await waitForReplyRunSuccessorAdmission(executionKey, null);
        discovery.mockClear();
        await expect(snapshot.fingerprintAsync(run.run)).rejects.toThrow();
        expect(discovery).not.toHaveBeenCalled();
      } finally {
        discovery.mockRestore();
        admitted.operation.complete();
        await waitForReplyRunSuccessorAdmission(executionKey, null);
      }
    });
  },
);
