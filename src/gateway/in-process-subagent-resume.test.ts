import { expect, expectTypeOf, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions as CoreHandler } from "../plugin-sdk/core.js";
import type { GatewayRequestHandlerOptions as RuntimeHandler } from "../plugin-sdk/gateway-runtime.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import {
  bindInProcessSubagentResume,
  readInProcessSubagentResume,
} from "./in-process-subagent-resume.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it("keeps resume authority outside both public SDK handler types", () => {
  type CoreInternal = NonNullable<NonNullable<CoreHandler["client"]>["internal"]>;
  type RuntimeInternal = NonNullable<NonNullable<RuntimeHandler["client"]>["internal"]>;
  expectTypeOf<Extract<"subagentResume", keyof CoreInternal>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<"subagentResume", keyof RuntimeInternal>>().toEqualTypeOf<never>();
});

it("preserves private authority through principal capture but not copying or serialization", () => {
  const resume = {
    caller: { agentId: "main", sessionKey: "agent:main:main", assertCurrent: vi.fn() },
    childSessionKey: "agent:main:dashboard:child",
    childSessionId: "child-session",
    previousRunId: "paused",
    taskRunId: "task",
    generation: 1,
    createdAt: 1,
  };
  const client = createSyntheticPluginRuntimeClient();
  bindInProcessSubagentResume(client.internal!, resume);
  expect(readInProcessSubagentResume(captureAgentTurnPrincipal(client)?.internal)).toBe(resume);
  expect(client.internal).not.toHaveProperty("subagentResume");
  expect(readInProcessSubagentResume({ ...client.internal })).toBeUndefined();
  expect(readInProcessSubagentResume(structuredClone(client.internal))).toBeUndefined();
  expect(JSON.stringify(client.internal)).not.toContain("subagentResume");
  expect(readInProcessSubagentResume({ subagentResume: resume })).toBeUndefined();
});
