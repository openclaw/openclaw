import { afterEach, expect, it, vi } from "vitest";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as exec from "../../infra/exec-request-context.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveEmbeddedRunTerminal } from "../embedded-agent-runner/run/terminal-resolution.js";
import {
  expectComplete,
  makeTerminalInput,
  textAssistant,
} from "../embedded-agent-runner/run/terminal-resolution.test-support.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createPluginsTool } from "./plugins-tool.js";
import { handoffSessionTool } from "./session-tool-handoff.js";

const request = { action: "reloadAndResume", pluginId: "reload-fixture" };

function runningOperation(sessionKey: string, sessionId: string, storeScope: string) {
  const operation = createTestReplyOperation({
    sessionKey,
    sessionId,
    target: captureSessionTarget({ storeScope, sessionKey, incarnation: sessionId }),
  });
  operation.setPhase("running");
  return operation;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

it.each([
  {
    id: "retained after-turn handoff with an empty final answer",
    caller: { turnSourceChannel: "webchat" },
    stored: "webchat",
    expectedRoute: false,
    afterTurn: true,
  },
  {
    id: "webchat turn without recipient",
    caller: { turnSourceChannel: "webchat" },
    stored: "telegram",
    expectedRoute: true,
  },
  {
    id: "Control UI turn addressed to its session",
    caller: {
      turnSourceChannel: "webchat",
      turnSourceTo: "agent:main:reload-route",
    },
    stored: "telegram",
    expectedRoute: true,
  },
  {
    id: "internal source hint",
    caller: { turnSourceChannel: "heartbeat" },
    stored: "telegram",
    expectedRoute: true,
  },
  {
    id: "external Telegram turn",
    caller: { turnSourceChannel: "telegram", turnSourceTo: "999" },
    stored: "telegram",
    expectedRoute: false,
  },
  {
    id: "caller without a turn source",
    caller: {},
    stored: "telegram",
    expectedRoute: false,
  },
  {
    id: "internal hint with its own recipient",
    caller: { turnSourceChannel: "heartbeat", turnSourceTo: "999" },
    stored: "telegram",
    expectedRoute: false,
  },
  {
    id: "session without an external route",
    caller: {
      turnSourceChannel: "webchat",
      turnSourceTo: "agent:main:reload-route",
    },
    stored: "webchat",
    expectedRoute: false,
  },
  {
    id: "Telegram turn without a recipient",
    caller: { turnSourceChannel: "telegram" },
    stored: "telegram",
    expectedRoute: false,
  },
] as const)("selects the reload resume route: $id", async (scenario) => {
  const { caller, stored, expectedRoute } = scenario;
  const afterTurn = "afterTurn" in scenario;
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:reload-route";
    const sessionId = "reload-route-session";
    const runId = "reload-route-run";
    const scope = { agentId: "main", sessionKey };
    const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    setRuntimeConfigSnapshot(config);
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({
        context:
          stored === "telegram"
            ? { channel: "telegram", to: "999" }
            : { channel: "webchat", to: sessionKey },
      }),
    });
    const operation = runningOperation(
      sessionKey,
      sessionId,
      resolveSessionStorePathCore(undefined, { agentId: "main" }),
    );
    operation.attachBackend({ kind: "embedded", runId, cancel: () => {} });
    const cleanup = createDeferredCore();
    const observed = createDeferredCore<Parameters<typeof events.enqueueSessionEventForHost>[1]>();
    let resumedText = "";
    vi.spyOn(events, "enqueueSessionEventForHost").mockImplementation((text, options) => {
      resumedText = text;
      observed.resolve(options);
      return {
        id: "resume-route",
        cancel: () => false,
        accepted: Promise.resolve({ ok: true }),
        settled: Promise.resolve({
          status: "completed",
          executionStarted: true,
          delivered: false,
        }),
      };
    });
    const endpoint = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
      respond(true, { ok: true, runtime: { generation: 2, pluginIds: ["reload-fixture"] } });
    });
    const deferredWork = vi.fn(async () => ({ ok: true, answer: "Retained result" }));
    const context = createContext(
      [["plugins.reload", "operator.admin", "plugins", endpoint]],
      () => config,
    );
    context.resolveGatewayContext = () => context;
    const invoke = () =>
      withSessionControllerOwner(operation, async () => {
        const options = {
          sessionId,
          runId,
          onYield: () => operation.completeWithAfterClearBarrier(cleanup.promise),
        };
        const result = afterTurn
          ? await handoffSessionTool({
              ...options,
              operation,
              name: "Reload",
              yield: "after_turn",
              run: deferredWork,
              formatResult: JSON.stringify,
            })
          : await createPluginsTool(options).execute("reload-route", request);
        expect(result.details).toMatchObject({ status: "started" });
      });
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
        () =>
          withOperatorToolGatewayAuthority(
            { scopes: ["operator.admin"], operatorRoleActor: { kind: "system" } },
            () =>
              exec.withExecRequestTurn({ identity: { ...scope, sessionId, runId } }, () =>
                withGatewayToolCallerIdentity({ ...scope, ...caller }, invoke),
              ),
          ),
      );
      if (afterTurn) {
        expect(deferredWork).not.toHaveBeenCalled();
        const terminal = await resolveEmbeddedRunTerminal(
          makeTerminalInput({
            assistant: textAssistant("", { stopReason: "stop" }),
            runParams: {
              sessionId,
              sessionKey,
              runId,
              messageChannel: "webchat",
              replyOperation: operation,
            },
            attemptOverrides: {
              toolMetas: [{ toolName: "sessions_send", asyncStarted: true }],
              itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
              replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
              currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
            },
          }),
        );
        expectComplete(terminal);
        expect(terminal.result.meta.error).toBeUndefined();
        expect(terminal.result.meta.continuationPending).toBe(true);
        expect(terminal.result.payloads ?? []).toEqual([]);
        operation.completeWithAfterClearBarrier(cleanup.promise);
      }
      cleanup.resolve();
      const options = await observed.promise;
      if (afterTurn) {
        expect(resumedText).toContain('"answer":"Retained result"');
        expect(deferredWork).toHaveBeenCalledTimes(1);
        expect(options.source).toBe("tool_handoff");
      }
      if (expectedRoute) {
        expect(options.deliveryContext).toEqual({ channel: "webchat" });
      } else {
        expect(options).not.toHaveProperty("deliveryContext");
      }
    } finally {
      cleanup.resolve();
      operation.complete();
    }
  });
});
