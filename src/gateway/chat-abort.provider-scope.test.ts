import { afterEach, expect, it, vi } from "vitest";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { resetSessionControllerStateForTest } from "../sessions/session-lifecycle-admission.test-support.js";
import { abortChatRunsForProvider, registerChatAbortController } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

afterEach(() => resetSessionControllerStateForTest());

it.each([true, false])(
  "provider cancellation stays in its originating Gateway (bound=%s)",
  (bound) => {
    const resolveLocal: GatewayContextResolver = () => undefined;
    const resolveForeign: GatewayContextResolver = () => undefined;
    const register = (runId: string, resolver: GatewayContextResolver) =>
      withPluginRuntimeGatewayContextResolver(resolver, () =>
        registerChatAbortController({
          runId,
          sessionKey: "agent:main:shared",
          sessionId: "shared-session",
          target: captureSessionTarget({
            storeScope: `/synthetic/provider-scope/${runId}/sessions.db`,
            sessionKey: "agent:main:shared",
            incarnation: "shared-session",
            agentId: "main",
          }),
          agentId: "main",
          providerId: "openai",
          timeoutMs: 60_000,
        }),
      );
    const local = register("local-run", resolveLocal);
    const foreign = register("foreign-run", resolveForeign);
    const result = abortChatRunsForProvider(
      {
        resolveGatewayContext: bound ? resolveLocal : undefined,
        chatRunState: createChatRunState(),
        removeChatRun: vi.fn(),
        agentRunSeq: new Map(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
      },
      {
        cfg: { agents: { entries: { main: {} } } },
        providerId: "openai",
        stopReason: "auth-revoked",
      },
    );
    expect(result.runIds).toEqual(bound ? ["local-run"] : []);
    expect(local.controller.signal.aborted).toBe(bound);
    expect(foreign.controller.signal.aborted).toBe(false);
    local.cleanup();
    foreign.cleanup();
  },
);
