import { expectTypeOf } from "vitest";
import type { AgentMessage } from "../../src/plugin-sdk/agent-core.js";
import type { AuthStorage, SessionManager } from "../../src/plugin-sdk/agent-sessions.js";

// Exposes the awaited selected-store display path without opening credential storage.
expectTypeOf<typeof AuthStorage.resolvePathForDisplayAsync>().toEqualTypeOf<
  (agentDir?: string, env?: NodeJS.ProcessEnv) => Promise<string>
>();

// Retains the synchronous context result and exposes an awaited consumer contract.
expectTypeOf<
  ReturnType<typeof SessionManager.readSessionContext<number>>
>().toEqualTypeOf<number>();
expectTypeOf<ReturnType<typeof SessionManager.readSessionContextAsync<number>>>().toEqualTypeOf<
  Promise<number>
>();
expectTypeOf<Parameters<typeof SessionManager.readSessionContextAsync<number>>[1]>().toEqualTypeOf<
  (messages: Iterable<AgentMessage>, header: unknown) => number | Promise<number>
>();
