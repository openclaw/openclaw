import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setRpcSourceProjectSessionActive } from "../../sessions/session-controller.rpc-sources.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as terminalLifecycle from "../chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createAgentEventTestHarness } from "../server-chat.agent-events.test-harness.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import { captureRpcTargetForTest } from "./rpc-source-fixtures.test-support.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
// mock-isolation: Exercise real RPC and persistence while keeping model dispatch and credentials outside this fixture.
vi.mock("../composer-prediction-completion.js", () => ({ completeComposerPrediction: complete }));

beforeEach(() => complete.mockReset().mockResolvedValue("What should I try next?"));

async function fixture(enabled = true) {
  const feature = { enabled };
  const cfg: OpenClawConfig = rolePolicyConfig();
  cfg.gateway = {
    ...cfg.gateway,
    controlUi: { experimental: { composerPredictions: feature } },
  };
  setRuntimeConfigSnapshot(cfg);
  const client = roleClient("write", "prediction-owner");
  client.connId = "prediction-client";
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:prediction",
    sessionId: "prediction-session",
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    status: "done",
    lastRunId: "completed",
    createdActor: {
      type: "human",
      source: "profile",
      id: expectDefined(client.authenticatedUserProfile, "profile").profileId,
    },
  });
  const dialogue = [
    { role: "user", content: "Help me find a safe next step." },
    { role: "toolResult", content: "private tool result" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "Here are the tradeoffs." },
      ],
    },
  ];
  for (const message of dialogue) {
    await appendTranscriptMessage(scope, { message });
  }
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  return {
    feature,
    client,
    scope,
    context,
    predict: (runId = "completed", signal?: AbortSignal, caller = client) =>
      chatRpc(context, caller, "chat.predict", { sessionKey: scope.sessionKey, runId }, signal),
  };
}

const testState = { scenario: "minimal", prepareProfileCatalog: true } as const;

async function withPredictionTest(
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  enabled = true,
) {
  await withOpenClawTestState(testState, async () => {
    try {
      await run(await fixture(enabled));
    } finally {
      await disposeSessionReadContexts();
    }
  });
}

it("gates disabled, stale, and nonterminal requests before inference", () =>
  withPredictionTest(async (f) => {
    expect(await f.predict()).toMatchObject([true, { text: null }]);
    f.feature.enabled = true;
    expect(await f.predict("old-run")).toMatchObject([true, { text: null }]);
    await patchSessionEntryCore(f.scope, () => ({
      status: undefined,
      lifecycleRunId: "successor",
    }));
    expect(await f.predict()).toMatchObject([true, { text: null }]);
    expect(complete).not.toHaveBeenCalled();
  }, false));

it("enforces read and compose authority at the registered RPC", () =>
  withPredictionTest(async (f) => {
    for (const role of ["view", "none"] as const) {
      const client = roleClient(role, "prediction-" + role);
      client.connId = role;
      expect((await f.predict(undefined, undefined, client))[0]).toBe(false);
    }
    const readOnlyClient = {
      ...f.client,
      connect: { ...f.client.connect, scopes: ["operator.read"] },
    };
    expect((await f.predict(undefined, undefined, readOnlyClient))[0]).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  }));

it("uses only bounded visible dialogue and never appends a prediction", () =>
  withPredictionTest(async (f) => {
    f.client.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    const before = await loadTranscriptEvents(f.scope);
    expect(await f.predict()).toMatchObject([true, { text: "What should I try next?" }]);
    expect(complete).toHaveBeenCalledOnce();
    const input = complete.mock.calls[0]?.[0];
    expect(input.choice).toBe("utility");
    expect(JSON.parse(input.conversation)).toEqual([
      { role: "user", text: "Help me find a safe next step." },
      { role: "assistant", text: "Here are the tradeoffs." },
    ]);
    expect(await loadTranscriptEvents(f.scope)).toEqual(before);
  }));

it.each(["suggestion", "disabled", "cancelled"] as const)(
  "waits for final-event terminal persistence before prediction (%s)",
  (outcome) =>
    withPredictionTest(async (f) => {
      const runId = "completed";
      await patchSessionEntryCore(f.scope, () => ({
        status: undefined,
        lastRunId: "previous",
        lifecycleRunId: runId,
      }));
      const registration = registerChatAbortController({
        target: captureRpcTargetForTest(f.scope),
        runId,
        ...f.scope,
        timeoutMs: 60_000,
      });
      const entry = expectDefined(registration.entry, "registered prediction run");
      const releaseSource = await claimRpcSourceForTest(entry);
      registration.initializeTiming();
      registration.markExecutionStarted();
      const releaseWrite = createDeferred();
      const writeEntered = createDeferred();
      const waitEntered = createDeferred();
      let terminalWrite: Promise<void> | undefined;
      const h = createAgentEventTestHarness({
        persistGatewaySessionLifecycleEventForEvent: async () => {
          writeEntered.resolve();
          await releaseWrite.promise;
          await patchSessionEntryCore(f.scope, () => ({
            status: "done",
            lastRunId: runId,
            lifecycleRunId: undefined,
          }));
        },
        trackTrackedRunTerminalPersistence: ({ persistence }) => {
          // Attach the event handler's exact write to its real run registration.
          terminalWrite = persistence;
          setRpcSourceProjectSessionActive(entry, false);
          entry.adapter.projectSessionTerminalPending = true;
          entry.adapter.projectSessionTerminalPersistence = persistence;
          void persistence.then(() => {
            entry.adapter.projectSessionTerminalPending = false;
            entry.adapter.projectSessionTerminalPersistence = undefined;
            entry.adapter.projectSessionTerminalPersisted = true;
          });
        },
      });
      const originalWait = terminalLifecycle.waitForChatAbortTerminalPersistence;
      const waitSpy = vi
        .spyOn(terminalLifecycle, "waitForChatAbortTerminalPersistence")
        .mockImplementation((pending) => {
          waitEntered.resolve();
          return originalWait(pending);
        });
      const controller = new AbortController();
      let prediction: ReturnType<typeof f.predict> | undefined;
      try {
        h.register(runId, f.scope.sessionKey, runId, { agentId: f.scope.agentId });
        h.chatRunState.getOrCreate(runId).buffer = "Here are the tradeoffs.";
        await h.emit(runId, "lifecycle", { phase: "end" }, f.scope);
        await writeEntered.promise;
        expect(h.chat().at(-1)?.[1]).toMatchObject({ state: "final", runId });
        expect(loadSessionEntry(f.scope)).toMatchObject({ lifecycleRunId: runId });
        expect(loadSessionEntry(f.scope)?.status).not.toBe("done");
        prediction = f.predict(runId, controller.signal);
        await awaitGateBeforeSettlement(
          waitEntered.promise,
          prediction,
          "prediction returned before joining terminal persistence",
        );
        expect(complete).not.toHaveBeenCalled();
        if (outcome === "cancelled") {
          controller.abort();
          expect((await prediction)[0]).toBe(false);
          expect(complete).not.toHaveBeenCalled();
          expect(loadSessionEntry(f.scope)?.lifecycleRunId).toBe(runId);
        } else {
          if (outcome === "disabled") {
            f.feature.enabled = false;
          }
          releaseWrite.resolve();
          expect(await prediction).toMatchObject([
            true,
            { text: outcome === "suggestion" ? "What should I try next?" : null },
          ]);
          expect(complete).toHaveBeenCalledTimes(outcome === "suggestion" ? 1 : 0);
        }
      } finally {
        releaseWrite.resolve();
        await terminalWrite;
        await prediction;
        waitSpy.mockRestore();
        releaseSource();
        registration.cleanup();
        await h.handler.dispose();
      }
    }),
);

it.each(["store", "gateway"] as const)(
  "does not join terminal persistence owned by another %s",
  (otherOwner) =>
    withPredictionTest(async (f) => {
      if (otherOwner === "gateway") {
        f.context.resolveGatewayContext = () => f.context;
      }
      const registration = registerChatAbortController({
        target: captureRpcTargetForTest({
          ...f.scope,
          ...(otherOwner === "store" ? { storeScope: "/synthetic/other-store" } : {}),
        }),
        runId: "completed",
        ...f.scope,
        timeoutMs: 60_000,
      });
      const entry = expectDefined(registration.entry, "foreign prediction run");
      entry.adapter.projectSessionTerminalPending = true;
      entry.adapter.projectSessionTerminalPersistence = Promise.resolve();
      const wait = vi
        .spyOn(terminalLifecycle, "waitForChatAbortTerminalPersistence")
        .mockResolvedValue();
      try {
        expect(await f.predict()).toMatchObject([true, { text: "What should I try next?" }]);
        expect(wait).not.toHaveBeenCalled();
        expect(complete).toHaveBeenCalledOnce();
      } finally {
        entry.adapter.projectSessionTerminalPending = false;
        entry.adapter.projectSessionTerminalPersistence = undefined;
        registration.cleanup();
        wait.mockRestore();
      }
    }),
);

it("discards a paid result if the feature or completed anchor changes", () =>
  withPredictionTest(async (f) => {
    complete.mockImplementationOnce(async () => {
      f.feature.enabled = false;
      return "stale suggestion";
    });
    expect(await f.predict()).toMatchObject([true, { text: null }]);
    f.feature.enabled = true;
    complete.mockImplementationOnce(async () => {
      await patchSessionEntryCore(f.scope, () => ({ lastRunId: "new-completed" }));
      return "stale suggestion";
    });
    expect(await f.predict()).toMatchObject([true, { text: null }]);
  }));
