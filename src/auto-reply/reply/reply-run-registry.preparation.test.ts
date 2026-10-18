import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { bindWorkerToolPreparation } from "../../agents/harness/host-private-capabilities.js";
import { createNativeSessionBindingAuthority } from "../../agents/harness/native-session/binding-authority.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageOptions,
  ReplyMessageInjectionOptions,
} from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

afterEach(() => {
  testing.resetSessionControllerForTest();
  vi.restoreAllMocks();
});

const overlay = { senderIsOwner: true, disableTools: false, traceAuthorized: false };
type Operation = ReturnType<typeof createTestReplyOperation>;
type Attempt = Awaited<ReturnType<typeof beginReplyMessageInjectionTarget>>;

function begin(operation: Operation, options: ReplyMessageInjectionOptions) {
  return beginReplyMessageInjectionTarget(
    captureCurrentReplyMessageInjectionTarget(operation.key)!,
    "retained source",
    { isInboundUserMessage: true, ...options },
  );
}
function preparationGate() {
  const entered = createDeferred();
  const resume = createDeferred();
  return {
    async pause() {
      entered.resolve();
      await resume.promise;
    },
    open: () => resume.resolve(),
    wait: (attempt: Attempt) =>
      awaitGateBeforeSettlement(entered.promise, attempt.outcome, "Preparation was not reached"),
    async settle(attempt?: Attempt) {
      resume.resolve();
      await attempt?.outcome;
    },
  };
}

async function createPolicyOperation(
  name: string,
  options: {
    mainAlias?: boolean;
    store?: string;
    policyStorePath?: string;
  } = {},
) {
  const { mainAlias } = options;
  const policyKey = `agent:main:${name}-policy`;
  const config: OpenClawConfig = {
    agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
    tools: { sandbox: { tools: { deny: ["exec"] } } },
  };
  if (mainAlias || options.store) {
    config.session = {
      ...(mainAlias ? { mainKey: `${name}-policy` } : {}),
      ...(options.store ? { store: options.store } : {}),
    };
  }
  setRuntimeConfigSnapshot(config);
  const policyEntry = await upsertSessionEntryCore(
    { agentId: "main", sessionKey: policyKey, storePath: options.policyStorePath },
    { sessionId: name, updatedAt: 1, sandboxMode: "off" },
  );
  if (!policyEntry) {
    throw new Error("Policy fixture entry was not created");
  }
  const run = createQueueTestRun({ prompt: name });
  Object.assign(run.run, {
    agentId: "main",
    sessionId: `${name}-run`,
    sessionKey: `agent:main:${name}`,
    runtimePolicySessionKey: mainAlias ? "agent:main:main" : policyKey,
    senderIsOwner: true,
    config,
  });
  const operation = createTestReplyOperation({
    sessionKey: run.run.sessionKey,
    sessionId: run.run.sessionId,
  });
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
  const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
  return { operation, fingerprint, policyKey, policyEntry };
}

function attachPreparedNativeBackend(
  operation: Operation,
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
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
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
      const gate = preparationGate();
      const read = sessionReads.withSessionEntriesFromStoresInWorker;
      const delayed = vi
        .spyOn(sessionReads, "withSessionEntriesFromStoresInWorker")
        .mockImplementation(async (inputs, consume, options) => {
          if (options?.ordered || (kind === "compatibility" && inputs.length === 0)) {
            await gate.pause();
          }
          return read(inputs, consume, options);
        });
      const calls = kind === "worker" ? observeMainThreadSql() : undefined;
      let attempt: Attempt | undefined;
      try {
        attempt = await begin(target.operation, {
          toolAuthorityOverlay: overlay,
          toolAuthorityPreparation: sourcePreparation,
        });
        await gate.wait(attempt);
        calls?.expectIdle();
        await updateSessionEntry({ agentId: "main", sessionKey: source.policyKey }, () => ({
          sandboxMode: undefined,
        }));
        calls?.clear();
        gate.open();
        expect((await attempt.outcome).status).toBe(kind === "worker" ? "rejected" : "failed");
        await expect(attempt.acceptance).resolves.toBe(false);
        expect(effect).not.toHaveBeenCalled();
        expect(sourcePreparation.compatAssertCurrent).toHaveBeenCalledTimes(
          kind === "worker" ? 0 : 1,
        );
        calls?.expectIdle();
      } finally {
        await gate.settle(attempt);
        calls?.restore();
        delayed.mockRestore();
      }
    });
  },
);

it.each([
  { change: "session", admission: "compatibility" },
  { change: "revision", admission: "compatibility" },
  { change: "metadata", admission: "compatibility" },
  { change: "alias", admission: "worker" },
  { change: "other-store", admission: "worker" },
  { change: "missing-store", admission: "worker" },
  { change: "other-store-move", admission: "worker" },
] as const)(
  "retains file policy lineage in $admission admission after $change",
  async ({ change, admission }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const multipleStores = change.startsWith("other-store") || change === "missing-store";
      const store = state.statePath("configured/agents/{agentId}/sessions/sessions.json");
      const resolveStore = (template?: string) =>
        resolveSessionStorePathCore(template, { agentId: "main", env: state.env });
      const configuredStorePath = resolveStore(store);
      const defaultStorePath = resolveStore();
      if (multipleStores && change !== "missing-store") {
        await upsertSessionEntryCore(
          {
            agentId: "main",
            sessionKey: "agent:main:unrelated-policy",
            storePath: defaultStorePath,
          },
          { sessionId: "unrelated-policy", updatedAt: 1 },
        );
      }
      const options = multipleStores
        ? {
            store,
            policyStorePath: change === "missing-store" ? defaultStorePath : configuredStorePath,
          }
        : {};
      const { operation, fingerprint, policyKey, policyEntry } = await createPolicyOperation(
        "retained-policy",
        { mainAlias: true, ...options },
      );
      let atBackend = false;
      const effect = attachPreparedNativeBackend(operation, fingerprint, () => {
        atBackend = true;
      });
      const gate = preparationGate();
      const project = operation.projectToolAuthorityFingerprintAsync;
      const delayed = vi
        .spyOn(operation, "projectToolAuthorityFingerprintAsync")
        .mockImplementation(async (caller) => {
          const value = await project(caller);
          if (atBackend) {
            await gate.pause();
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
      const attempt = await begin(operation, {
        toolAuthorityOverlay: overlay,
        toolAuthorityPreparation: preparation,
      });
      try {
        await gate.wait(attempt);
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
        gate.open();
        await attempt.outcome;
        const accepted = change === "metadata";
        await expect(attempt.acceptance).resolves.toBe(accepted);
        expect(effect).toHaveBeenCalledTimes(accepted ? 1 : 0);
      } finally {
        await gate.settle(attempt);
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
    const gate = preparationGate();
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
                await gate.pause();
                preparation.assertCurrent();
                await effect();
              },
            } satisfies ReplyBackendMessageInjectionV2,
          }),
    });
    operation.setPhase("running");
    const attempt = await begin(operation, {
      toolAuthorityFingerprint: "policy",
      ...(kind === "with-overlay" ? { toolAuthorityOverlay: overlay } : {}),
      assertCurrent: separateCaller ? assertSource : undefined,
      toolAuthorityPreparation: {
        ...(kind === "legacy-run-with-caller" ? { authorityKind: "run" as const } : {}),
        assertCurrent: separateCaller ? () => {} : assertSource,
        async prepareCurrent() {},
        compatAssertCurrent: assertSource,
      },
    });
    try {
      if (!legacy) {
        await gate.wait(attempt);
        source.current = false;
        gate.open();
      }
      await expect(attempt.outcome).resolves.toMatchObject(
        legacy
          ? { status: "rejected", reason: "guarded_injection_unsupported" }
          : { status: "failed" },
      );
      await expect(attempt.acceptance).resolves.toBe(false);
      expect(effect).not.toHaveBeenCalled();
    } finally {
      await gate.settle(attempt);
    }
  },
);

it.each(["completion", "observer", "before-acceptance"] as const)(
  "retains prepared native input custody after %s failure",
  async (failurePoint) => {
    const completionError = new Error("backend completion failed");
    const observerError = new Error("acceptance observer failed");
    const onQueueAccepted = vi.fn(() => {
      if (failurePoint === "observer") {
        throw observerError;
      }
    });
    const queueMessage = vi.fn(async () => {});
    const queueMessageAsync = vi.fn<
      NonNullable<ReplyBackendMessageInjectionV2["queueMessageAsync"]>
    >(async (_text, options, preparation) => {
      await preparation.prepareCurrent();
      preparation.assertCurrent();
      if (failurePoint !== "before-acceptance") {
        options?.onQueueAccepted?.(true);
      }
      throw completionError;
    });
    const operation = createTestReplyOperation();
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage,
        queueMessageAsync,
      },
    });
    operation.setPhase("running");
    const target = captureCurrentReplyMessageInjectionTarget(operation.key)!;
    const attempt = await beginReplyMessageInjectionTarget(target, "continue", {
      onQueueAccepted,
      toolAuthorityPreparation: {
        assertCurrent() {},
        compatAssertCurrent() {},
        async prepareCurrent() {},
      },
    });

    await expect(attempt.outcome).resolves.toMatchObject(
      failurePoint === "before-acceptance"
        ? { status: "rejected", reason: "runtime_rejected" }
        : { status: "indeterminate" },
    );
    await expect(attempt.acceptance).resolves.toBe(failurePoint !== "before-acceptance");
    expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(failurePoint !== "before-acceptance");
    expect(queueMessageAsync).toHaveBeenCalledOnce();
    expect(queueMessage).not.toHaveBeenCalled();
    expect(operation.result).toBeNull();
    expect(operation.abortSignal.aborted).toBe(false);
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
      supportsTranscriptCommitWait: true,
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
    const confirm = vi.fn(async () => {
      throw new Error("transcript confirmation failed");
    });
    const recorder = {
      ...createUserTurnTranscriptRecorder({
        input: { text: "uncertain" },
        target: createTestUserTurnTranscriptTarget(),
      }),
      confirmSteerTargetRunIdForPersistence: confirm,
    };
    const attempt = await beginReplyMessageInjectionTarget(
      captureCurrentReplyMessageInjectionTarget(operation.key)!,
      "uncertain",
      {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "policy",
        personalToolParticipant: participantFailure ? { senderId: "incoming" } : undefined,
        waitForTranscriptCommit: failure === "confirmation-rejection",
        userTurnTranscriptRecorder: recorder,
      },
    );

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
    expect(confirm).toHaveBeenCalledTimes(failure === "confirmation-rejection" ? 1 : 0);
    if (participant) {
      expect(participant).toHaveBeenCalledOnce();
      expect(() => operation.personalToolParticipants!.resolve("incoming")).toThrow(
        "User is not a participant",
      );
    }
  },
);
