import { afterEach, expect, it, vi } from "vitest";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as exec from "../../infra/exec-request-context.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createPluginsTool } from "./plugins-tool.js";

const request = { action: "reloadAndResume", pluginId: "reload-fixture" };

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

it.each([
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
] as const)("selects the reload resume route: $id", async ({ caller, stored, expectedRoute }) => {
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
    const operation = createTestReplyOperation({ sessionKey, sessionId });
    operation.setPhase("running");
    const cleanup = createDeferredCore();
    const observed = createDeferredCore<Parameters<typeof events.enqueueSessionEventForHost>[1]>();
    vi.spyOn(events, "enqueueSessionEventForHost").mockImplementation((_text, options) => {
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
    const context = createContext();
    context.getRuntimeConfig = () => config;
    const methods = createGatewayMethodRegistry([
      {
        name: "plugins.reload",
        scope: "operator.admin",
        owner: { kind: "core", area: "plugins" },
        handler: endpoint,
      },
    ]);
    context.getGatewayMethodRegistry = () => methods;
    context.resolveGatewayContext = () => context;
    const invoke = async () => {
      const result = await createPluginsTool({
        sessionId,
        runId,
        onYield: () => operation.completeWithAfterClearBarrier(cleanup.promise),
      }).execute("reload-route", request);
      expect(result.details).toMatchObject({ status: "started" });
    };
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
      cleanup.resolve();
      const options = await observed.promise;
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
