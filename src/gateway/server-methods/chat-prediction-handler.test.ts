import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as terminalLifecycle from "../chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createAgentEventTestHarness } from "../server-chat.agent-events.test-harness.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
// mock-isolation: Exercise real RPC and persistence while keeping model dispatch and credentials outside this fixture.
vi.mock("../composer-prediction-completion.js", () => ({ completeComposerPrediction: complete }));

beforeEach(() => complete.mockReset().mockResolvedValue("What should I try next?"));

async function request(
  context: GatewayRequestContext,
  client: GatewayClient,
  runId = "completed",
  signal?: AbortSignal,
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "prediction",
      method: "chat.predict",
      params: { sessionKey: "agent:main:prediction", runId },
    },
    respond,
    client,
    context,
    signal,
    isWebchatConnect: () => true,
  });
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "prediction response");
}

async function fixture(enabled = true) {
  const cfg: OpenClawConfig = rolePolicyConfig();
  cfg.gateway = {
    ...cfg.gateway,
    controlUi: { experimental: { composerPredictions: { enabled } } },
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
  await appendTranscriptMessage(scope, {
    eventId: "user",
    message: { role: "user", content: "Help me find a safe next step." },
  });
  await appendTranscriptMessage(scope, {
    eventId: "tool",
    message: { role: "toolResult", content: "private tool result" },
  });
  await appendTranscriptMessage(scope, {
    eventId: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "Here are the tradeoffs." },
      ],
    },
  });
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  return { cfg, client, scope, context };
}

const testState = { scenario: "minimal", prepareProfileCatalog: true } as const;

async function withPredictionTest(run: () => Promise<void>) {
  await withOpenClawTestState(testState, async () => {
    try {
      await run();
    } finally {
      await disposeSessionReadContexts();
    }
  });
}

describe("registered chat.predict", () => {
  it("gates disabled, stale, and nonterminal requests before inference", async () => {
    await withPredictionTest(async () => {
      const f = await fixture(false);
      expect(await request(f.context, f.client)).toMatchObject([true, { text: null }]);
      f.cfg.gateway!.controlUi!.experimental!.composerPredictions!.enabled = true;
      expect(await request(f.context, f.client, "old-run")).toMatchObject([true, { text: null }]);
      await patchSessionEntryCore(f.scope, () => ({
        status: undefined,
        lifecycleRunId: "successor",
      }));
      expect(await request(f.context, f.client)).toMatchObject([true, { text: null }]);
      expect(complete).not.toHaveBeenCalled();
    });
  });

  it("enforces read and compose authority at the registered RPC", async () => {
    await withPredictionTest(async () => {
      const f = await fixture();
      for (const role of ["view", "none"] as const) {
        const client = roleClient(role, "prediction-" + role);
        client.connId = role;
        expect((await request(f.context, client))[0]).toBe(false);
      }
      const readOnlyClient = {
        ...f.client,
        connect: { ...f.client.connect, scopes: ["operator.read"] },
      };
      expect((await request(f.context, readOnlyClient))[0]).toBe(false);
      expect(complete).not.toHaveBeenCalled();
    });
  });

  it("uses only bounded visible dialogue and never appends a prediction", async () => {
    await withPredictionTest(async () => {
      const f = await fixture();
      f.client.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
      const before = await loadTranscriptEvents(f.scope);
      expect(await request(f.context, f.client)).toMatchObject([
        true,
        { text: "What should I try next?" },
      ]);
      expect(complete).toHaveBeenCalledOnce();
      const input = complete.mock.calls[0]?.[0];
      expect(input.choice).toBe("utility");
      expect(JSON.parse(input.conversation)).toEqual([
        { role: "user", text: "Help me find a safe next step." },
        { role: "assistant", text: "Here are the tradeoffs." },
      ]);
      expect(await loadTranscriptEvents(f.scope)).toEqual(before);
    });
  });

  it.each(["suggestion", "disabled", "cancelled"] as const)(
    "waits for final-event terminal persistence before prediction (%s)",
    async (outcome) => {
      await withPredictionTest(async () => {
        const f = await fixture();
        const runId = "completed";
        await patchSessionEntryCore(f.scope, () => ({
          status: undefined,
          lastRunId: "previous",
          lifecycleRunId: runId,
        }));
        const registration = registerChatAbortController({
          chatAbortControllers: f.context.chatAbortControllers,
          runId,
          ...f.scope,
          timeoutMs: 60_000,
        });
        const entry = expectDefined(registration.entry, "registered prediction run");
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
            entry.projectSessionActive = false;
            entry.projectSessionTerminalPending = true;
            entry.projectSessionTerminalPersistence = persistence;
            void persistence.then(() => {
              entry.projectSessionTerminalPending = false;
              entry.projectSessionTerminalPersistence = undefined;
              entry.projectSessionTerminalPersisted = true;
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
        let prediction: ReturnType<typeof request> | undefined;
        try {
          h.register(runId, f.scope.sessionKey, runId, { agentId: f.scope.agentId });
          h.chatRunState.getOrCreate(runId).buffer = "Here are the tradeoffs.";
          await h.emit(
            runId,
            "lifecycle",
            { phase: "end" },
            {
              sessionKey: f.scope.sessionKey,
              sessionId: f.scope.sessionId,
              agentId: f.scope.agentId,
            },
          );
          await writeEntered.promise;
          expect(h.chat().at(-1)?.[1]).toMatchObject({ state: "final", runId });
          expect(loadSessionEntry(f.scope)).toMatchObject({ lifecycleRunId: runId });
          expect(loadSessionEntry(f.scope)?.status).not.toBe("done");
          prediction = request(f.context, f.client, runId, controller.signal);
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
              f.cfg.gateway!.controlUi!.experimental!.composerPredictions!.enabled = false;
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
          registration.cleanup();
          await h.handler.dispose();
        }
      });
    },
  );

  it("discards a paid result if the feature or completed anchor changes", async () => {
    await withPredictionTest(async () => {
      const f = await fixture();
      complete.mockImplementationOnce(async () => {
        f.cfg.gateway!.controlUi!.experimental!.composerPredictions!.enabled = false;
        return "stale suggestion";
      });
      expect(await request(f.context, f.client)).toMatchObject([true, { text: null }]);
      f.cfg.gateway!.controlUi!.experimental!.composerPredictions!.enabled = true;
      complete.mockImplementationOnce(async () => {
        await patchSessionEntryCore(f.scope, () => ({ lastRunId: "new-completed" }));
        return "stale suggestion";
      });
      expect(await request(f.context, f.client)).toMatchObject([true, { text: null }]);
    });
  });
});
