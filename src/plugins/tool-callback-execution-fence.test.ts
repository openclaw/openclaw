import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const state = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
  persisted: [] as string[],
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../config/sessions.js", () => ({ resolveSessionStorePathCore: () => "fixture" }));
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async (
    _scope: unknown,
    check: () => void,
    consume: (read: unknown) => Promise<unknown>,
  ) => {
    await state.gate;
    check();
    return consume({ ok: true, value: { sessionId: "session" } });
  },
}));
vi.mock("../agents/subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: () => ({
    runId: "run-child",
    collect: false,
    createdAt: 1,
    execution: { status: "running" },
  }),
}));
vi.mock("../infra/agent-run-registry.js", () => ({
  getAgentRunContext: () => ({
    sessionKey: "agent:main:subagent:child",
    sessionId: "session",
    agentId: "main",
  }),
}));
// Persistence boundary: the worker admission guard runs before any row is written.
vi.mock("../agents/plugin-async-callback.js", () => ({
  runPluginAsyncCallbackCommand: async (
    command: { type: string; input: { binding: unknown } },
    guard: (binding: unknown) => void,
  ) => {
    guard(command.input.binding);
    state.persisted.push(command.type);
    return { token: "token", expiresAt: 1000, queueId: "expiry" };
  },
}));

import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";
import { bindPluginToolCallbacks } from "./tool-factory-runtime.js";
import type { OpenClawPluginToolContext, OpenClawPluginToolFactory } from "./tool-types.js";

type Issue = OpenClawPluginToolContext<2>["issueAsyncCallback"];

function bindProbe(body: (issue: NonNullable<Issue>) => Promise<void>) {
  const factory: OpenClawPluginToolFactory<2> = {
    contextVersion: 2,
    create: (ctx) => ({
      name: "probe",
      label: "Probe",
      description: "Probe callback lifetime",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await body(ctx.issueAsyncCallback!);
        return { content: [{ type: "text" as const, text: "pending" }], details: {} };
      },
    }),
  };
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "probe", contracts: { tools: ["probe"] } });
  builder.registry.plugins.push(record);
  builder
    .createApi(record, { config: {}, registrationMode: "full" })
    .registerTool(factory, { name: "probe" });
  const entry = builder.registry.tools[0]!;
  const ctx = createPluginToolFactoryContext({
    entry,
    registry: builder.registry,
    context: { agentId: "main", sessionKey: "agent:main:subagent:child", sessionId: "session" },
    runId: "run-child",
    assertInvocationCurrent: () => {},
  });
  const registered = entry.factory(ctx);
  return bindPluginToolCallbacks(
    entry,
    builder.registry,
    registered as Exclude<typeof registered, null | undefined | unknown[]>,
    ctx.assertInvocationCurrent,
  );
}

beforeEach(() => {
  state.gate = undefined;
  state.persisted.length = 0;
});

it("persists a callback issued and awaited inside execute", async () => {
  let token: string | undefined;
  const tool = bindProbe(async (issue) => {
    token = (await issue({ ttlMs: 60_000 })).token;
  });
  await tool.execute("call-1", {});
  expect(token).toBe("token");
  expect(state.persisted).toEqual(["pluginCallback.issue"]);
});

it("rejects a detached call made after execute settles, before any persistence", async () => {
  const fire = createDeferred();
  let detached: Promise<unknown> | undefined;
  const tool = bindProbe(async (issue) => {
    // The timer callback inherits this execution's async context.
    detached = fire.promise.then(() => issue({ ttlMs: 60_000 }));
    detached.catch(() => {});
  });
  await tool.execute("call-1", {});
  fire.resolve();
  await expect(detached).rejects.toThrow("registered tool execution");
  expect(state.persisted).toEqual([]);
});

it("rejects at worker admission when execute settles while issuance is in flight", async () => {
  const gate = createDeferred();
  state.gate = gate.promise;
  let inFlight: Promise<unknown> | undefined;
  const tool = bindProbe(async (issue) => {
    inFlight = issue({ ttlMs: 60_000 });
    inFlight.catch(() => {});
  });
  await tool.execute("call-1", {});
  gate.resolve();
  await expect(inFlight).rejects.toThrow("registered tool execution");
  expect(state.persisted).toEqual([]);
});
