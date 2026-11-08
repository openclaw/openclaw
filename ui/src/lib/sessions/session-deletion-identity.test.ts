// @vitest-environment node
import { expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { createSessionState } from "./session-capability.ts";
import { createSessionDeletions } from "./session-deletions.ts";
import type { UiSessionDefaultsHost } from "./session-key.ts";

const defaults = { defaultAgentId: "ops", mainKey: "home", mainSessionKey: "agent:ops:current" };
const hello = (values = defaults) => ({ snapshot: { sessionDefaults: values } });
const result = (...sessions: GatewaySessionRow[]): SessionsListResult => ({
  ts: 1,
  path: "",
  count: sessions.length,
  defaults: { modelProvider: null, model: null, contextTokens: null },
  sessions,
});
const row = (key: string, agentId?: string): GatewaySessionRow => ({
  key,
  agentId,
  sessionId: "old",
  kind: "direct",
});

function fixture(initial: UiSessionDefaultsHost) {
  let routing = initial;
  const state = createSessionState();
  const deletions = createSessionDeletions({
    snapshot: () => ({
      ...routing,
      client: null,
      phase: "connected",
      hello: routing.hello
        ? { ...gatewayHelloForMethods([]), snapshot: routing.hello.snapshot }
        : null,
    }),
    connection: createGatewayConnectionLifecycle({ client: null, phase: "connected" }),
    defer: () => false,
    patchNow: async () => null,
    requestRevision: () => 1,
    readState: () => state,
    publish: () => {},
    publishedRow: () => undefined,
    redecorateLists: () => {},
    invalidateLists: () => {},
    reconcileMutation: async () => ({ status: "refreshed" }),
    reconcilePreviousConnection: async () => false,
    retire: () => {},
  });
  return { deletions, setRouting: (next: UiSessionDefaultsHost) => (routing = next) };
}

it.each<{
  name: string;
  before: UiSessionDefaultsHost;
  after: UiSessionDefaultsHost;
  key: string;
  target: string;
  agent: string;
}>([
  {
    name: "selected agent",
    before: { assistantAgentId: "ops" },
    after: { assistantAgentId: "work" },
    key: "global",
    target: "global",
    agent: "work",
  },
  {
    name: "agents presence",
    before: {},
    after: { agentsList: {} },
    key: "main",
    target: "agent:main:main",
    agent: "main",
  },
  {
    name: "agents default",
    before: { agentsList: { defaultId: "ops", mainKey: "home" } },
    after: { agentsList: { defaultId: "work", mainKey: "home" } },
    key: "main",
    target: "agent:work:home",
    agent: "work",
  },
  {
    name: "agents main key",
    before: { agentsList: { defaultId: "ops", mainKey: "home" } },
    after: { agentsList: { defaultId: "ops", mainKey: "next" } },
    key: "main",
    target: "agent:ops:next",
    agent: "ops",
  },
  {
    name: "agents scope",
    before: { agentsList: { defaultId: "ops" } },
    after: { agentsList: { defaultId: "ops", scope: "global" } },
    key: "main",
    target: "global",
    agent: "ops",
  },
  {
    name: "hello defaults presence",
    before: {},
    after: { hello: hello() },
    key: "main",
    target: "agent:ops:current",
    agent: "ops",
  },
  {
    name: "hello default agent",
    before: { hello: hello() },
    after: { hello: hello({ ...defaults, defaultAgentId: "work" }) },
    key: "main",
    target: "agent:work:home",
    agent: "work",
  },
  {
    name: "hello main key",
    before: { hello: hello() },
    after: { hello: hello({ ...defaults, mainKey: "next" }) },
    key: "home",
    target: "home",
    agent: "ops",
  },
  {
    name: "hello advertised target",
    before: { hello: hello() },
    after: { hello: hello({ ...defaults, mainSessionKey: "agent:ops:next" }) },
    key: "main",
    target: "agent:ops:next",
    agent: "ops",
  },
])("rechecks a warm row after $name changes", ({ before, after, key, target, agent }) => {
  const h = fixture(before);
  const held = result(row(key));
  const owner = { scope: {} };
  h.deletions.reconcileList(held, 1);
  expect(h.deletions.apply(held, owner)).toBe(held);
  h.setRouting(after);
  h.deletions.reconcileList(result({ ...row(target, agent), sessionId: "current" }), 2);
  expect(h.deletions.apply(held, owner)?.sessions).toEqual([]);
});

it.each(["key", "row agent", "query agent", "generation"] as const)(
  "rechecks a warm row after its %s changes",
  (change) => {
    const h = fixture({ assistantAgentId: "ops" });
    const heldRow = row("global");
    const held = result(heldRow);
    const owner = { scope: { agentId: "ops" } };
    h.deletions.reconcileList(held, 1, "ops");
    expect(h.deletions.apply(held, owner)).toBe(held);
    const key = change === "key" ? "agent:ops:other" : "global";
    const agent = change === "row agent" || change === "query agent" ? "work" : "ops";
    h.deletions.reconcileList(result({ ...row(key, agent), sessionId: "current" }), 2);
    if (change === "key") {
      heldRow.key = key;
    }
    if (change === "row agent") {
      heldRow.agentId = agent;
    }
    if (change === "query agent") {
      owner.scope.agentId = agent;
    }
    expect(h.deletions.apply(held, owner)?.sessions).toEqual([]);
  },
);

it("resolves retained rows once across query owners and fresh snapshot wrappers", () => {
  let reads = 0;
  const h = fixture({
    agentsList: {
      defaultId: "ops",
      get mainKey() {
        reads += 1;
        return "home";
      },
    },
  });
  const held = result(row("main"), row("agent:ops:other"));
  h.deletions.reconcileList(held, 1);
  reads = 0;
  expect(h.deletions.apply(held, { scope: {} })).toBe(held);
  expect(reads).toBeGreaterThan(1);
  reads = 0;
  expect(h.deletions.apply(held, { scope: {} })).toBe(held);
  expect(reads).toBe(1);
});
