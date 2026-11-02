/** Drives api.runtime.agent.explainToolAvailability from a real plugin loaded by the loader. */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../loader.test-fixtures.js";
import type { PluginRuntime } from "./types.js";

const PLUGIN_ID = "tool-availability-probe";
const RUNTIME_KEY = "__toolAvailabilityProbeRuntime";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginLoaderTestStateForTest();
  delete (globalThis as Record<string, unknown>)[RUNTIME_KEY];
});
afterAll(cleanupPluginLoaderFixturesForTest);

function loadProbePlugin(policy: OpenClawConfig): PluginRuntime["agent"] {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: PLUGIN_ID,
    registration: `globalThis.${RUNTIME_KEY} = api.runtime;`,
  });
  const config: OpenClawConfig = {
    ...policy,
    agents: {
      ...policy.agents,
      defaults: { model: { primary: "openai/gpt-5.5" }, ...policy.agents?.defaults },
      entries: { main: {}, ...policy.agents?.entries },
    },
    plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] },
  };
  const registry = loadOpenClawPlugins({
    cache: false,
    workspaceDir: plugin.dir,
    config,
    onlyPluginIds: [plugin.id],
  });
  expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
  // The Gateway publishes this snapshot during startup; runtime calls read it live.
  setRuntimeConfigSnapshot(config);
  const runtime = (globalThis as Record<string, unknown>)[RUNTIME_KEY] as PluginRuntime;
  return runtime.agent;
}

describe("api.runtime.agent.explainToolAvailability", () => {
  it("names the blocking stage and config path for each policy layer", async () => {
    await withStateDirEnv("openclaw-tool-availability-", async () => {
      const agent = loadProbePlugin({
        tools: {
          allow: ["read", "browser", "web_search", PLUGIN_ID],
          deny: ["browser"],
          byProvider: { openai: { deny: ["web_search"] } },
        },
      });

      const report = await agent.explainToolAvailability({
        agentId: "main",
        toolNames: ["read", "browser", "web_search", "exec", "probe_tool"],
      });

      expect(report.agentId).toBe("main");
      expect(report.sandbox).toEqual({ mode: "off", source: "agents.defaults.sandbox.mode" });
      expect(report.tools).toEqual([
        { name: "read", available: true },
        {
          name: "browser",
          available: false,
          block: expect.objectContaining({ stage: "deny", source: "tools.deny" }),
        },
        {
          name: "web_search",
          available: false,
          block: expect.objectContaining({
            stage: "deny",
            source: 'tools.byProvider["openai"].deny',
          }),
        },
        {
          name: "exec",
          available: false,
          block: expect.objectContaining({
            stage: "allowlist",
            source: "tools.allow",
            fix: 'Add "exec" to tools.allow.',
          }),
        },
        {
          name: "probe_tool",
          available: false,
          block: expect.objectContaining({ stage: "allowlist", source: "tools.allow" }),
        },
      ]);
      // The plugin-ID allowlist entry admits every tool that plugin owns.
      const owned = await agent.explainToolAvailability({
        toolNames: ["probe_tool"],
        pluginId: PLUGIN_ID,
      });
      expect(owned.tools).toEqual([{ name: "probe_tool", available: true }]);
    });
  });

  it("reports the provider profile and sandbox policy of a session", async () => {
    await withStateDirEnv("openclaw-tool-availability-", async () => {
      const agent = loadProbePlugin({
        tools: {
          byProvider: { openai: { profile: "minimal" } },
          sandbox: { tools: { deny: ["read"] } },
        },
        agents: { defaults: { sandbox: { mode: "all" } } },
      });

      const report = await agent.explainToolAvailability({
        sessionKey: "agent:main:main",
        toolNames: ["read", "write"],
      });

      expect(report.sandbox).toEqual({
        mode: "all",
        source: "agents.defaults.sandbox.mode",
        sandboxed: true,
      });
      expect(report.tools).toEqual([
        {
          name: "read",
          available: false,
          block: expect.objectContaining({ stage: "sandbox", source: "tools.sandbox.tools.deny" }),
        },
        {
          name: "write",
          available: false,
          block: expect.objectContaining({
            stage: "provider-policy",
            source: 'tools.byProvider["openai"].profile',
          }),
        },
      ]);
    });
  });
  it("matches account-scoped group policy through the session's delivery route", async () => {
    await withStateDirEnv("openclaw-tool-availability-", async () => {
      const groupId = "-100123";
      const agent = loadProbePlugin({
        channels: {
          telegram: {
            // The default account's restriction must not apply to the work account's session.
            groups: { [groupId]: { tools: { deny: ["read"] } } },
            accounts: { work: { groups: { [groupId]: { tools: { deny: ["exec"] } } } } },
          },
        },
      });
      const sessionKey = `agent:main:telegram:group:${groupId}`;
      const to = `telegram:${groupId}`;
      // Seed the session through the host store owner that channel ingress writes through.
      await upsertSessionEntry({
        agentId: "main",
        sessionKey,
        entry: {
          sessionId: "telegram-work-group",
          updatedAt: Date.now(),
          chatType: "group",
          groupId,
          delivery: {
            kind: "external",
            context: { channel: "telegram", accountId: "work", to },
            origin: { provider: "telegram", accountId: "work", to },
            route: {
              channel: "telegram",
              accountId: "work",
              target: { to, chatType: "group" },
            },
          },
        },
      });

      const report = await agent.explainToolAvailability({
        sessionKey,
        toolNames: ["exec", "read"],
      });

      expect(report.tools).toEqual([
        {
          name: "exec",
          available: false,
          block: expect.objectContaining({ stage: "deny", source: "group tools.allow" }),
        },
        { name: "read", available: true },
      ]);
    });
  });
});
