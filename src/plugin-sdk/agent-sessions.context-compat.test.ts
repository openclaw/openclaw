import { expectTypeOf, it } from "vitest";
import type { AgentMessage } from "./agent-core.js";
import type { SessionManager } from "./agent-sessions.js";

it("retains the synchronous context result and exposes an awaited consumer contract", () => {
  expectTypeOf<
    ReturnType<typeof SessionManager.readSessionContext<number>>
  >().toEqualTypeOf<number>();
  expectTypeOf<ReturnType<typeof SessionManager.readSessionContextAsync<number>>>().toEqualTypeOf<
    Promise<number>
  >();
  expectTypeOf<
    Parameters<typeof SessionManager.readSessionContextAsync<number>>[1]
  >().toEqualTypeOf<
    (messages: Iterable<AgentMessage>, header: unknown) => number | Promise<number>
  >();
});
