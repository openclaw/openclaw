import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionResourceToolPolicy } from "./session-resource-tool-policy.js";

const { storageRead, runtimeOwnership } = vi.hoisted(() => ({
  storageRead: vi.fn(() => {
    throw new Error("Unexpected synchronous session storage read");
  }),
  runtimeOwnership: vi.fn(),
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadExactSessionEntryReadOnly: storageRead,
  loadSessionEntryByIdReadOnly: storageRead,
  loadSessionEntryReadOnly: storageRead,
}));
vi.mock("../agents/harness/registry.js", () => ({
  getRegisteredAgentHarness: () => ({
    harness: { resolveSessionRuntimeOwnership: runtimeOwnership },
  }),
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
  let config: OpenClawConfig = options.config ?? {};
  const entries = new Map<string, SessionEntry>([
    [key, { sessionId: "session-1", updatedAt: 1, ...options.entry }],
  ]);
  return {
    entries,
    setConfig(next: OpenClawConfig) {
      config = next;
    },
    resolve: (toolName = "browser") =>
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
        readSessionEntry: (query) => entries.get(query.key),
        toolName,
      }),
  };
}

describe("session resource tool policy", () => {
  beforeEach(() => {
    storageRead.mockClear();
    runtimeOwnership.mockReset();
  });

  it.each<OpenClawConfig>([
    { tools: { profile: "minimal" } },
    { tools: { deny: ["browser"] } },
    {
      tools: { byProvider: { openai: { deny: ["browser"] } } },
      agents: { defaults: { model: "openai/test-model" } },
    },
    { agents: { list: [{ id: "main", tools: { deny: ["browser"] } }] } },
    {
      agents: {
        defaults: { model: "openai/test-model" },
        list: [{ id: "main", tools: { byProvider: { openai: { deny: ["browser"] } } } }],
      },
    },
    { tools: { toolsBySender: { "*": { deny: ["browser"] } } } },
  ])("honors each canonical configured restriction: %j", (config) => {
    expect(() => fixture({ config }).resolve()).toThrow("current tool policy");
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("evaluates current row and policy facts without owning resource lifetime", () => {
    const test = fixture({ config: { tools: { profile: "minimal", alsoAllow: ["browser"] } } });
    test.resolve();
    test.entries.set(sessionKey, { ...test.entries.get(sessionKey)!, updatedAt: 2 });
    expect(() => test.resolve()).not.toThrow();
    test.setConfig({ tools: { deny: ["browser"] } });
    expect(() => test.resolve()).toThrow("current tool policy");
    test.setConfig({});
    expect(() => test.resolve()).not.toThrow();
  });

  it("rechecks selected model policy when the stored provider changes", () => {
    const test = fixture({
      config: {
        agents: { defaults: { model: "anthropic/test-model" } },
        tools: { byProvider: { openai: { deny: ["browser"] } } },
      },
    });
    test.resolve();
    test.entries.set(sessionKey, {
      ...test.entries.get(sessionKey)!,
      providerOverride: "openai",
      modelOverride: "test-model",
    });
    expect(() => test.resolve()).toThrow("current tool policy");
    expect(storageRead).not.toHaveBeenCalled();
  });

  it.each(["agent:main:dashboard:child", "agent:main:acp:child"])(
    "honors persisted inherited denial for %s",
    (key) => {
      const test = fixture({
        key,
        entry: {
          spawnDepth: 1,
          subagentRole: "orchestrator",
          spawnedBy: "agent:other:dashboard:parent",
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["browser", "portal"],
          inheritedToolDeny: ["browser"],
        },
      });
      expect(() => test.resolve()).toThrow("current tool policy");
      expect(test.resolve("portal")).toMatchObject({ sandboxRequired: false });
      expect(storageRead).not.toHaveBeenCalled();
    },
  );

  it("uses a prepared cross-agent ACP parent without falling through to SQLite", () => {
    const key = "agent:main:acp:child";
    const test = fixture({ key, entry: { spawnedBy: "agent:other:acp:parent" } });
    test.entries.set("agent:other:acp:parent", {
      sessionId: "parent",
      updatedAt: 1,
      subagentRole: "orchestrator",
      spawnDepth: 1,
    });
    expect(test.resolve()).toMatchObject({ sandboxRequired: false });
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("denies a missing parent rather than acquiring unprepared database facts", () => {
    const test = fixture({
      key: "agent:main:acp:child",
      entry: { spawnedBy: "agent:other:acp:missing" },
    });
    expect(() => test.resolve()).toThrow("current tool policy");
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("keeps sandbox requirements and sandbox tool restrictions visible to the resource owner", () => {
    const test = fixture({
      entry: { sandbox: "required" },
      config: { tools: { sandbox: { tools: { allow: ["browser"], deny: [] } } } },
    });
    expect(test.resolve()).toMatchObject({ sandboxRequired: true, sandboxed: true });
    expect(() => fixture({ entry: { sandbox: "required" } }).resolve()).toThrow(
      "current tool policy",
    );
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("rejects locked native sessions before asking their storage-backed ownership resolver", () => {
    const test = fixture({
      entry: { agentHarnessId: "test-harness", modelSelectionLocked: true },
    });
    expect(() => test.resolve()).toThrow("sessions with locked model selection");
    expect(runtimeOwnership).not.toHaveBeenCalled();
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("supports ordinary unlocked native-harness sessions without native ownership reads", () => {
    const test = fixture({ entry: { agentHarnessId: "test-harness" } });
    expect(test.resolve()).toMatchObject({ sandboxRequired: false });
    expect(runtimeOwnership).not.toHaveBeenCalled();
    expect(storageRead).not.toHaveBeenCalled();
  });
});
