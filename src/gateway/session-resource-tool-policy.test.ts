import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionResourceToolPolicy } from "./session-resource-tool-policy.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import type { SessionRowProjection } from "./session-row-projection.js";

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
const target = { agentId: "main", sessionKey, sessionId: "session-1" };
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
  const context = bindSessionRowProjection(
    { getRuntimeConfig: () => config } as GatewayRequestContext,
    () => projection,
  );
  const projection = {
    prepareMembership: async () => undefined,
    sharingTarget(query: { key: string; agentId: string }) {
      const entry = entries.get(query.key);
      return entry
        ? {
            agentId: query.agentId,
            canonicalKey: query.key,
            entry,
            storeKey: query.key,
            storeKeys: [query.key],
            storePath: `/test/${query.agentId}/sessions`,
          }
        : null;
    },
  } as SessionRowProjection;
  return {
    entries,
    setConfig(next: OpenClawConfig) {
      config = next;
    },
    prepare: (toolName = "browser") =>
      prepareSessionResourceToolPolicy({
        context,
        client,
        target: { ...target, sessionKey: key },
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
  ])("honors each canonical configured restriction: %j", async (config) => {
    await expect(fixture({ config }).prepare()).rejects.toThrow("current tool policy");
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("keeps a permitted resource across ordinary row updates and retires it after a policy denial", async () => {
    const test = fixture({ config: { tools: { profile: "minimal", alsoAllow: ["browser"] } } });
    const policy = await test.prepare();
    test.entries.set(sessionKey, { ...test.entries.get(sessionKey)!, updatedAt: 2 });
    expect(() => policy.assertCurrent()).not.toThrow();
    test.setConfig({ tools: { deny: ["browser"] } });
    expect(() => policy.assertCurrent()).toThrow("current tool policy");
    test.setConfig({});
    expect(() => policy.assertCurrent()).toThrow("current tool policy");
  });

  it("rechecks selected model policy when the stored provider changes", async () => {
    const test = fixture({
      config: {
        agents: { defaults: { model: "anthropic/test-model" } },
        tools: { byProvider: { openai: { deny: ["browser"] } } },
      },
    });
    const policy = await test.prepare();
    test.entries.set(sessionKey, {
      ...test.entries.get(sessionKey)!,
      providerOverride: "openai",
      modelOverride: "test-model",
    });
    expect(() => policy.assertCurrent()).toThrow("current tool policy");
    expect(storageRead).not.toHaveBeenCalled();
  });

  it.each(["agent:main:dashboard:child", "agent:main:acp:child"])(
    "honors persisted inherited denial for %s",
    async (key) => {
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
      await expect(test.prepare()).rejects.toThrow("current tool policy");
      await expect(test.prepare("portal")).resolves.toMatchObject({ sandboxRequired: false });
      expect(storageRead).not.toHaveBeenCalled();
    },
  );

  it("uses a prepared cross-agent ACP parent without falling through to SQLite", async () => {
    const key = "agent:main:acp:child";
    const test = fixture({ key, entry: { spawnedBy: "agent:other:acp:parent" } });
    test.entries.set("agent:other:acp:parent", {
      sessionId: "parent",
      updatedAt: 1,
      subagentRole: "orchestrator",
      spawnDepth: 1,
    });
    await expect(test.prepare()).resolves.toMatchObject({ sandboxRequired: false });
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("denies a missing parent rather than acquiring unprepared database facts", async () => {
    const test = fixture({
      key: "agent:main:acp:child",
      entry: { spawnedBy: "agent:other:acp:missing" },
    });
    await expect(test.prepare()).rejects.toThrow("current tool policy");
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("keeps sandbox requirements and sandbox tool restrictions visible to the resource owner", async () => {
    const test = fixture({
      entry: { sandbox: "required" },
      config: { tools: { sandbox: { tools: { allow: ["browser"], deny: [] } } } },
    });
    await expect(test.prepare()).resolves.toMatchObject({ sandboxRequired: true, sandboxed: true });
    await expect(fixture({ entry: { sandbox: "required" } }).prepare()).rejects.toThrow(
      "current tool policy",
    );
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("rejects locked native sessions before asking their storage-backed ownership resolver", async () => {
    const test = fixture({
      entry: { agentHarnessId: "test-harness", modelSelectionLocked: true },
    });
    await expect(test.prepare()).rejects.toThrow("sessions with locked model selection");
    expect(runtimeOwnership).not.toHaveBeenCalled();
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("supports ordinary unlocked native-harness sessions without native ownership reads", async () => {
    const test = fixture({ entry: { agentHarnessId: "test-harness" } });
    await expect(test.prepare()).resolves.toMatchObject({ sandboxRequired: false });
    expect(runtimeOwnership).not.toHaveBeenCalled();
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("retires authority when the session incarnation changes", async () => {
    const test = fixture();
    const policy = await test.prepare();
    test.entries.set(sessionKey, { sessionId: "replacement", updatedAt: 2 });
    expect(() => policy.assertCurrent()).toThrow("current tool policy");
    test.entries.set(sessionKey, { sessionId: "session-1", updatedAt: 3 });
    expect(() => policy.assertCurrent()).toThrow("current tool policy");
  });
});
