import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { bindWorkerToolPreparation } from "../../agents/harness/host-private-capabilities.js";
import { createNativeSessionBindingAuthority } from "../../agents/harness/native-session/binding-authority.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageOptions,
} from "./reply-run-registry.contracts.js";
import { beginReplyMessageInjectionTarget, replyRunRegistry } from "./reply-run-registry.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

const overlay = { senderIsOwner: true, disableTools: false, traceAuthorized: false };

async function createPolicyOperation(
  name: string,
  options: {
    incognito?: boolean;
    mainAlias?: boolean;
    store?: string;
    policyStorePath?: string;
  } = {},
) {
  const { incognito, mainAlias } = options;
  const policyKey = incognito
    ? `agent:main:dashboard:incognito-${name}`
    : `agent:main:${name}-policy`;
  const policyEntry = await upsertSessionEntryCore(
    { agentId: "main", sessionKey: policyKey, storePath: options.policyStorePath },
    {
      sessionId: name,
      updatedAt: 1,
      sandboxMode: "off",
      ...(incognito ? { incognito: true } : {}),
    },
  );
  if (!policyEntry) {
    throw new Error("Policy fixture entry was not created");
  }
  const run = createQueueTestRun({ prompt: name });
  Object.assign(run.run, {
    agentId: "main",
    sessionId: name,
    sessionKey: `agent:main:${name}`,
    runtimePolicySessionKey: mainAlias ? "agent:main:main" : policyKey,
    senderIsOwner: true,
    config: {
      ...(mainAlias || options.store
        ? {
            session: {
              ...(mainAlias ? { mainKey: `${name}-policy` } : {}),
              ...(options.store ? { store: options.store } : {}),
            },
          }
        : {}),
      agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
      tools: { sandbox: { tools: { deny: ["exec"] } } },
    },
  });
  const operation = createTestReplyOperation({ sessionKey: run.run.sessionKey, sessionId: name });
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
  const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
  return { operation, fingerprint, policyKey, policyEntry };
}

function attachPreparedNativeBackend(
  operation: ReturnType<typeof createTestReplyOperation>,
  fingerprint: string | undefined,
  beforePreparation?: () => void,
) {
  const authority = createNativeSessionBindingAuthority([], () => {});
  const effect = vi.fn();
  operation.attachBackend({
    kind: "embedded",
    cancel() {},
    toolAuthorityFingerprint: fingerprint,
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      async queueMessage() {
        throw new Error("Expected prepared steering");
      },
      async queueMessageAsync(_text, options, preparation) {
        beforePreparation?.();
        await authority.withPreparedCurrent!(() => {
          effect();
          options?.onQueueAccepted?.(true);
        }, [preparation]);
      },
    },
  });
  operation.setPhase("running");
  return effect;
}

it.each(["worker", "compatibility"] as const)(
  "retains supplied %s source policy alongside an overlay through final native admission",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const source = await createPolicyOperation("source");
      const target = await createPolicyOperation("target");
      const assertSourcePolicy = (fingerprint: string | undefined) => {
        if (fingerprint !== source.fingerprint) {
          throw new Error("source policy revoked");
        }
      };
      const sourcePreparation = {
        assertCurrent: vi.fn(),
        prepareCurrent: vi.fn(async () =>
          assertSourcePolicy(await source.operation.projectToolAuthorityFingerprintAsync(overlay)),
        ),
        compatAssertCurrent: vi.fn(() =>
          assertSourcePolicy(source.operation.projectToolAuthorityFingerprint(overlay)),
        ),
      };
      if (kind === "worker") {
        bindWorkerToolPreparation(sourcePreparation);
      }
      const effect = attachPreparedNativeBackend(target.operation, target.fingerprint);
      const entered = createDeferred();
      const resume = createDeferred();
      const read = sessionReads.withSessionEntriesFromStoresInWorker;
      const delayed = vi
        .spyOn(sessionReads, "withSessionEntriesFromStoresInWorker")
        .mockImplementation(async (inputs, consume, options) => {
          if (options?.ordered || (kind === "compatibility" && inputs.length === 0)) {
            entered.resolve();
            await resume.promise;
          }
          return read(inputs, consume, options);
        });
      const calls = kind === "worker" ? observeMainThreadSql() : undefined;
      let attempt: Awaited<ReturnType<typeof beginReplyMessageInjectionTarget>> | undefined;
      try {
        attempt = await beginReplyMessageInjectionTarget(
          replyRunRegistry.resolveCurrentMessageInjectionTarget(target.operation.key)!,
          "overlay with retained source",
          {
            isInboundUserMessage: true,
            toolAuthorityOverlay: overlay,
            toolAuthorityPreparation: sourcePreparation,
          },
        );
        await awaitGateBeforeSettlement(
          entered.promise,
          attempt.outcome,
          "Native admission was not reached",
        );
        calls?.expectIdle();
        const foreign = new DatabaseSync(
          resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        );
        try {
          foreign
            .prepare(
              "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.sandboxMode') WHERE session_key = ?",
            )
            .run(source.policyKey);
        } finally {
          foreign.close();
        }
        calls?.clear();
        resume.resolve();
        expect((await attempt.outcome).status).toBe(kind === "worker" ? "rejected" : "failed");
        await expect(attempt.acceptance).resolves.toBe(false);
        expect(effect).not.toHaveBeenCalled();
        expect(sourcePreparation.compatAssertCurrent).toHaveBeenCalledTimes(
          kind === "worker" ? 0 : 1,
        );
        calls?.expectIdle();
      } finally {
        resume.resolve();
        await attempt?.outcome;
        calls?.restore();
        delayed.mockRestore();
      }
    });
  },
);

it.each([
  { storage: "file", change: "session", admission: "compatibility" },
  { storage: "file", change: "revision", admission: "compatibility" },
  { storage: "file", change: "metadata", admission: "compatibility" },
  { storage: "incognito", change: "session", admission: "compatibility" },
  { storage: "file", change: "alias", admission: "worker" },
  { storage: "file", change: "other-store", admission: "worker" },
  { storage: "file", change: "missing-store", admission: "worker" },
  { storage: "file", change: "other-store-move", admission: "worker" },
] as const)(
  "retains $storage policy lineage in $admission admission after $change",
  async ({ storage, change, admission }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const multipleStores = change.startsWith("other-store") || change === "missing-store";
      const store = state.statePath(
        "configured",
        "agents",
        "{agentId}",
        "sessions",
        "sessions.json",
      );
      const configuredStorePath = resolveSessionStorePathCore(store, {
        agentId: "main",
        env: state.env,
      });
      const defaultStorePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: state.env,
      });
      const otherKey = "agent:main:unrelated-policy";
      if (multipleStores && change !== "missing-store") {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: otherKey, storePath: defaultStorePath },
          { sessionId: "unrelated-policy", updatedAt: 1 },
        );
      }
      const { operation, fingerprint, policyKey, policyEntry } = await createPolicyOperation(
        "retained-policy",
        {
          incognito: storage === "incognito",
          mainAlias: storage === "file",
          ...(multipleStores
            ? {
                store,
                policyStorePath:
                  change === "missing-store" ? defaultStorePath : configuredStorePath,
              }
            : {}),
        },
      );
      let atBackend = false;
      const effect = attachPreparedNativeBackend(operation, fingerprint, () => {
        atBackend = true;
      });
      const entered = createDeferred();
      const resume = createDeferred();
      const project = operation.projectToolAuthorityFingerprintAsync;
      const delayed = vi
        .spyOn(operation, "projectToolAuthorityFingerprintAsync")
        .mockImplementation(async (caller) => {
          const value = await project(caller);
          if (atBackend) {
            entered.resolve();
            await resume.promise;
          }
          return value;
        });
      const preparation = {
        assertCurrent() {},
        async prepareCurrent() {},
        compatAssertCurrent() {},
      };
      if (admission === "worker") {
        bindWorkerToolPreparation(preparation);
      }
      const attempt = await beginReplyMessageInjectionTarget(
        replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!,
        "retained policy input",
        {
          isInboundUserMessage: true,
          toolAuthorityOverlay: overlay,
          toolAuthorityPreparation: preparation,
        },
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          attempt.outcome,
          "Final policy preparation was not reached",
        );
        if (multipleStores) {
          if (change === "other-store-move") {
            await deleteSessionEntryLifecycle({
              archiveTranscript: false,
              storePath: configuredStorePath,
              target: { canonicalKey: policyKey, storeKeys: [policyKey] },
            });
          }
          await upsertSessionEntryCore(
            {
              agentId: "main",
              sessionKey: policyKey,
              storePath: change === "missing-store" ? configuredStorePath : defaultStorePath,
            },
            { ...policyEntry, updatedAt: 2 },
          );
        } else if (change === "alias") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: "agent:main:main" },
            { sessionId: "conflicting-alias", updatedAt: 2, sandboxMode: "off" },
          );
        } else {
          await updateSessionEntry({ agentId: "main", sessionKey: policyKey }, () =>
            change === "session"
              ? { sessionId: "replacement" }
              : change === "revision"
                ? { lifecycleRevision: "replacement" }
                : { label: "renamed" },
          );
        }
        resume.resolve();
        await attempt.outcome;
        const accepted = change === "metadata";
        await expect(attempt.acceptance).resolves.toBe(accepted);
        expect(effect).toHaveBeenCalledTimes(accepted ? 1 : 0);
      } finally {
        resume.resolve();
        await attempt.outcome;
        delayed.mockRestore();
      }
    });
  },
);

it.each(["with-overlay", "separate-caller", "legacy", "legacy-run-with-caller"] as const)(
  "keeps every supplied authority through final admission: %s",
  async (kind) => {
    const operation = createTestReplyOperation();
    operation.bindToolAuthoritySnapshot({ fingerprint: () => "policy", project: () => "policy" });
    operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
    const entered = createDeferred();
    const resume = createDeferred();
    const effect = vi.fn(async () => {});
    const source = { current: true };
    const legacy = kind === "legacy" || kind === "legacy-run-with-caller";
    const separateCaller = kind === "separate-caller" || kind === "legacy-run-with-caller";
    const assertSource = () => {
      if (!source.current) {
        throw new Error("source owner revoked");
      }
    };
    operation.attachBackend({
      kind: "embedded",
      cancel() {},
      toolAuthorityFingerprint: "policy",
      ...(legacy
        ? { messageInjection: { isAvailable: () => true, queueMessage: effect } }
        : {
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              queueMessage: effect,
              queueMessageAsync: async (_text, _options, preparation) => {
                entered.resolve();
                await resume.promise;
                preparation.assertCurrent();
                await effect();
              },
            } satisfies ReplyBackendMessageInjectionV2,
          }),
    });
    operation.setPhase("running");
    const attempt = await beginReplyMessageInjectionTarget(
      replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!,
      "retained source",
      {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "policy",
        ...(kind === "with-overlay" ? { toolAuthorityOverlay: overlay } : {}),
        assertCurrent: separateCaller ? assertSource : undefined,
        toolAuthorityPreparation: {
          ...(kind === "legacy-run-with-caller" ? { authorityKind: "run" as const } : {}),
          assertCurrent: separateCaller ? () => {} : assertSource,
          async prepareCurrent() {},
          compatAssertCurrent: assertSource,
        },
      },
    );
    try {
      if (!legacy) {
        await awaitGateBeforeSettlement(
          entered.promise,
          attempt.outcome,
          "Prepared backend was not reached",
        );
        source.current = false;
        resume.resolve();
      }
      await expect(attempt.outcome).resolves.toMatchObject(
        legacy ? { status: "rejected", reason: "injection_unavailable" } : { status: "failed" },
      );
      await expect(attempt.acceptance).resolves.toBe(false);
      expect(effect).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await attempt.outcome;
    }
  },
);

it.each(["confirmation-rejection", "participant-callback", "participant-fulfilled"] as const)(
  "keeps accepted custody across %s",
  async (failure) => {
    const delivery = createDeferred();
    let queueOptions: ReplyBackendQueueMessageOptions | undefined;
    const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
    operation.bindToolAuthoritySnapshot({ fingerprint: () => "policy", project: () => "policy" });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      runId: "run-a",
      toolAuthorityFingerprint: "policy",
      cancel: vi.fn(),
      messageInjection: {
        isAvailable: () => true,
        queueMessage: vi.fn((_text, options) => {
          queueOptions = options;
          return delivery.promise;
        }),
      },
    });
    const participantFailure = failure.startsWith("participant-");
    const participant = participantFailure
      ? vi.spyOn(operation.personalToolParticipants!, "accept").mockImplementation(() => {
          throw new Error("participant registration failed");
        })
      : undefined;
    const confirmSteerTargetRunIdForPersistence = vi.fn(async () => {
      throw new Error("transcript confirmation failed");
    });
    const recorder = {
      ...createUserTurnTranscriptRecorder({
        input: { text: "uncertain" },
        target: createTestUserTurnTranscriptTarget(),
      }),
      confirmSteerTargetRunIdForPersistence,
    };
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const attempt = await beginReplyMessageInjectionTarget(target, "uncertain", {
      isInboundUserMessage: true,
      toolAuthorityFingerprint: "policy",
      personalToolParticipant: participantFailure ? { senderId: "incoming" } : undefined,
      waitForTranscriptCommit: failure === "confirmation-rejection",
      userTurnTranscriptRecorder: recorder,
    });

    if (failure === "participant-callback") {
      try {
        queueOptions?.onQueueAccepted?.(true);
      } catch (error) {
        delivery.reject(error);
      }
    } else {
      delivery.resolve();
    }

    await expect(attempt.outcome).resolves.toMatchObject({ status: "indeterminate" });
    await expect(attempt.acceptance).resolves.toBe(true);
    expect(confirmSteerTargetRunIdForPersistence).toHaveBeenCalledTimes(
      failure === "confirmation-rejection" ? 1 : 0,
    );
    if (participant) {
      expect(participant).toHaveBeenCalledOnce();
      expect(() => operation.personalToolParticipants!.resolve("incoming")).toThrow(
        "User is not a participant",
      );
    }
  },
);
