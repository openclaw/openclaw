import type { GatewayRequestHandlerOptions as CoreHandler } from "openclaw/plugin-sdk/core";
import type { GatewayRequestHandlerOptions as RuntimeHandler } from "openclaw/plugin-sdk/gateway-runtime";
import type { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { expectTypeOf, it } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";

it("retains the synchronous observer contract released in v2026.9.8 beside awaited companions", () => {
  type Context = CoreHandler["context"];
  expectTypeOf<RuntimeHandler["context"]>().toEqualTypeOf<Context>();
  expectTypeOf<
    NonNullable<NonNullable<ReturnType<typeof getPluginRuntimeGatewayRequestScope>>["context"]>
  >().toEqualTypeOf<Context>();
  type Observer = NonNullable<Context["sessionObserver"]>;
  type ReleasedSnapshot = {
    agentId: string;
    runId?: string;
    digest?: SessionObserverDigest;
    notes: Array<{ sequence: number; text: string }>;
  };
  type ReleasedObserver = {
    handleEvent: (event: AgentEventPayload) => void;
    setConnectionVisibility: (connId: string, visible: boolean) => void;
    removeConnection: (connId: string) => void;
    getCompanionSnapshot: (sessionKey: string, agentId?: string) => ReleasedSnapshot;
    dispose: () => void;
  };
  type AwaitedMethod = "handleEvent" | "getCompanionSnapshot" | "dispose";
  type AsyncObserver = {
    [Method in AwaitedMethod as `${Method}Async`]: (
      ...args: Parameters<ReleasedObserver[Method]>
    ) => Promise<ReturnType<ReleasedObserver[Method]>>;
  };
  expectTypeOf<Pick<Observer, keyof ReleasedObserver>>().toEqualTypeOf<ReleasedObserver>();
  expectTypeOf<Pick<Observer, keyof AsyncObserver>>().toEqualTypeOf<AsyncObserver>();
});
