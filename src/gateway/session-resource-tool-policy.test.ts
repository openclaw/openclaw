import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionResourceToolPolicy } from "./session-resource-tool-policy.js";

const { storageRead } = vi.hoisted(() => ({
  storageRead: vi.fn(() => {
    throw new Error("Unexpected synchronous session storage read");
  }),
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadExactSessionEntryReadOnly: storageRead,
  loadSessionEntryByIdReadOnly: storageRead,
  loadSessionEntryReadOnly: storageRead,
}));
vi.mock("../plugins/current-plugin-metadata-state.js", () => ({
  getGatewayPluginMetadataSnapshot: () => undefined,
}));

const sessionKey = "agent:main:dashboard:resource";
const client = {
  connect: { scopes: ["operator.write"], client: { id: "openclaw-control-ui", mode: "webchat" } },
  authenticatedUserProfile: { profileId: "reviewer", displayName: "Reviewer" },
} as GatewayClient;

function fixture(
  options: { config?: OpenClawConfig; entry?: Partial<SessionEntry>; key?: string } = {},
) {
  const key = options.key ?? sessionKey;
  const config: OpenClawConfig = options.config ?? {};
  const entries = new Map<string, SessionEntry>([
    [key, { sessionId: "session-1", updatedAt: 1, ...options.entry }],
  ]);
  return {
    entries,
    resolve: (toolName = "browser", assertNativeRuntimeCurrent?: () => void) =>
      resolveSessionResourceToolPolicy({
        config,
        client,
        current: {
          agentId: "main",
          canonicalKey: key,
          entry: entries.get(key)!,
          generation: Symbol("database"),
          storeKey: key,
          storeKeys: [key],
          storePath: "/test/main/sessions",
        },
        readPreparedSessionEntry: (query) => entries.get(query.key),
        toolName,
        assertNativeRuntimeCurrent,
      }),
  };
}

beforeEach(() => storageRead.mockClear());
afterEach(() => expect(storageRead).not.toHaveBeenCalled());

const denyBrowser = { deny: ["browser"] };
const providerPolicy = { byProvider: { openai: denyBrowser } };
const defaults = { model: "openai/test-model" };
const parentKey = "agent:other:acp:parent";
const childKey = "agent:main:acp:child";
const unlocked = { sandboxRequired: false };
type PolicyCase = NonNullable<Parameters<typeof fixture>[0]> & {
  parent?: SessionEntry;
  tool?: string;
  result?: Partial<ReturnType<typeof resolveSessionResourceToolPolicy>>;
};
const inherited = {
  tool: "portal",
  result: unlocked,
  entry: {
    spawnDepth: 1,
    subagentRole: "orchestrator",
    spawnedBy: "agent:other:dashboard:parent",
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: ["browser", "portal"],
    inheritedToolDeny: ["browser"],
  },
} satisfies PolicyCase;
it.each<PolicyCase>([
  { config: { tools: { profile: "minimal" } } },
  { config: { tools: denyBrowser } },
  { config: { tools: providerPolicy, agents: { defaults } } },
  { config: { agents: { entries: { main: { tools: denyBrowser } } } } },
  { config: { agents: { defaults, entries: { main: { tools: providerPolicy } } } } },
  { config: { tools: { toolsBySender: { "*": denyBrowser } } } },
  { key: "agent:main:dashboard:child", ...inherited },
  { key: childKey, ...inherited },
  {
    key: childKey,
    entry: { spawnedBy: parentKey },
    result: unlocked,
    parent: { sessionId: "parent", updatedAt: 1, subagentRole: "orchestrator", spawnDepth: 1 },
  },
  { key: childKey, entry: { spawnedBy: parentKey } },
  {
    entry: { sandbox: "required" },
    config: { tools: { sandbox: { tools: { allow: ["browser"], deny: [] } } } },
    result: { sandboxRequired: true, sandboxed: true },
  },
  { entry: { sandbox: "required" } },
])("enforces prepared resource policy %j", (options) => {
  const test = fixture(options);
  if (options.parent) {
    test.entries.set(parentKey, options.parent);
  }
  if (!options.result || options.tool) {
    expect(() => test.resolve()).toThrow("current tool policy");
  }
  if (options.result) {
    expect(test.resolve(options.tool)).toMatchObject(options.result);
  }
});

it("requires a live native owner for locked-session MCP App policy", () => {
  const test = fixture({ entry: { modelSelectionLocked: true } });
  expect(() => test.resolve()).toThrow("locked model selection");
  const assertCurrent = vi.fn();
  expect(() => test.resolve("browser", assertCurrent)).not.toThrow();
  assertCurrent.mockImplementation(() => {
    throw new Error("native binding changed");
  });
  expect(() => test.resolve("browser", assertCurrent)).toThrow("native binding changed");
});

it("rechecks selected model policy when the stored provider changes", () => {
  const test = fixture({
    config: {
      agents: { defaults: { model: "anthropic/test-model" } },
      tools: providerPolicy,
    },
  });
  test.resolve();
  test.entries.set(sessionKey, {
    ...test.entries.get(sessionKey)!,
    providerOverride: "openai",
    modelOverride: "test-model",
  });
  expect(() => test.resolve()).toThrow("current tool policy");
});
