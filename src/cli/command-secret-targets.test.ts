import { describe, expect, it, vi } from "vitest";

const REGISTRY_IDS = [
  "agents.defaults.memorySearch.remote.apiKey",
  "agents.list[].memorySearch.remote.apiKey",
  "channels.discord.token",
  "channels.discord.accounts.ops.token",
  "channels.discord.accounts.chat.token",
  "channels.telegram.botToken",
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
  "models.providers.openai.apiKey",
  "models.providers.google.apiKey",
  "messages.tts.providers.openai.apiKey",
  "plugins.entries.firecrawl.config.webFetch.apiKey",
  "plugins.entries.exa.config.webSearch.apiKey",
  "plugins.entries.searxng.config.webSearch.baseUrl",
  "skills.entries.demo.apiKey",
  "tools.web.search.apiKey",
  "tools.web.search.*.apiKey",
] as const;

vi.mock("../secrets/target-registry.js", () => ({
  listSecretTargetRegistryEntries: vi.fn(() =>
    REGISTRY_IDS.map((id) => ({
      id,
    })),
  ),
  discoverConfigSecretTargetsByIds: vi.fn((config: unknown, targetIds?: Iterable<string>) => {
    const allowed = targetIds ? new Set(targetIds) : null;
    const out: Array<{ path: string; pathSegments: string[] }> = [];
    const record = (path: string) => {
      if (allowed && !allowed.has(path)) {
        return;
      }
      out.push({ path, pathSegments: path.split(".") });
    };

    const channels = (config as { channels?: Record<string, unknown> } | undefined)?.channels;
    const discord = channels?.discord as
      | { token?: unknown; accounts?: Record<string, { token?: unknown }> }
      | undefined;

    if (discord?.token !== undefined) {
      record("channels.discord.token");
    }
    for (const [accountId, account] of Object.entries(discord?.accounts ?? {})) {
      if (account?.token !== undefined) {
        record(`channels.discord.accounts.${accountId}.token`);
      }
    }
    return out;
  }),
}));

import {
  getAgentRuntimeCommandSecretTargetIds,
  getModelsCommandSecretTargetIds,
  getQrRemoteCommandSecretTargetIds,
  getScopedChannelsCommandSecretTargets,
  getSecurityAuditCommandSecretTargetIds,
  getWebSearchCommandSecretTargetIds,
} from "./command-secret-targets.js";

describe("command secret target ids", () => {
  it("keeps static qr remote targets out of the registry path", () => {
    const ids = getQrRemoteCommandSecretTargetIds();
    expect(ids).toEqual(new Set(["gateway.remote.token", "gateway.remote.password"]));
  });

  it("keeps static model targets out of the registry path", () => {
    const ids = getModelsCommandSecretTargetIds();
    expect(ids.has("models.providers.*.apiKey")).toBe(true);
    expect(ids.has("models.providers.*.request.tls.key")).toBe(true);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("includes memorySearch remote targets for agent runtime commands", () => {
    const ids = getAgentRuntimeCommandSecretTargetIds();
    expect(ids.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(ids.has("agents.list[].memorySearch.remote.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.exa.config.webSearch.apiKey")).toBe(true);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("scopes web search command targets to search credentials only", () => {
    const ids = getWebSearchCommandSecretTargetIds({ provider: "exa" });
    expect(ids).toEqual(
      new Set([
        "plugins.entries.exa.config.webSearch.apiKey",
        "plugins.entries.searxng.config.webSearch.baseUrl",
        "tools.web.search.*.apiKey",
        "tools.web.search.apiKey",
      ]),
    );
    expect(ids.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(false);
    expect(ids.has("models.providers.openai.apiKey")).toBe(false);
    expect(ids.has("models.providers.google.apiKey")).toBe(false);
  });

  it("includes the Google model fallback only for Gemini web search", () => {
    const ids = getWebSearchCommandSecretTargetIds({
      config: { tools: { web: { search: { provider: "gemini" } } } } as never,
    });
    expect(ids.has("models.providers.google.apiKey")).toBe(true);
  });

  it("keeps the Google model fallback when web search can auto-detect providers", () => {
    const ids = getWebSearchCommandSecretTargetIds();
    expect(ids.has("models.providers.google.apiKey")).toBe(true);
  });

  it("lets the explicit web search provider override narrow configured Google targets", () => {
    const ids = getWebSearchCommandSecretTargetIds({
      config: { tools: { web: { search: { provider: "gemini" } } } } as never,
      provider: "exa",
    });
    expect(ids.has("models.providers.google.apiKey")).toBe(false);
  });

  it("includes channel targets for agent runtime when delivery needs them", () => {
    const ids = getAgentRuntimeCommandSecretTargetIds({ includeChannelTargets: true });
    expect(ids.has("channels.discord.token")).toBe(true);
    expect(ids.has("channels.telegram.botToken")).toBe(true);
  });

  it("includes gateway auth and channel targets for security audit", () => {
    const ids = getSecurityAuditCommandSecretTargetIds();
    expect(ids.has("channels.discord.token")).toBe(true);
    expect(ids.has("gateway.auth.token")).toBe(true);
    expect(ids.has("gateway.auth.password")).toBe(true);
    expect(ids.has("gateway.remote.token")).toBe(true);
    expect(ids.has("gateway.remote.password")).toBe(true);
  });

  it("scopes channel targets to the requested channel", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {} as never,
      channel: "discord",
    });

    expect(scoped.targetIds).toEqual(
      new Set([
        "channels.discord.accounts.chat.token",
        "channels.discord.accounts.ops.token",
        "channels.discord.token",
      ]),
    );
  });

  it("does not coerce missing accountId to default when channel is scoped", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {
        channels: {
          discord: {
            defaultAccount: "ops",
            accounts: {
              ops: {
                token: { source: "env", provider: "default", id: "DISCORD_OPS" },
              },
            },
          },
        },
      } as never,
      channel: "discord",
    });

    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.targetIds).toEqual(
      new Set([
        "channels.discord.accounts.chat.token",
        "channels.discord.accounts.ops.token",
        "channels.discord.token",
      ]),
    );
  });

  it("scopes allowed paths to channel globals + selected account", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_DEFAULT" },
            accounts: {
              ops: {
                token: { source: "env", provider: "default", id: "DISCORD_OPS" },
              },
              chat: {
                token: { source: "env", provider: "default", id: "DISCORD_CHAT" },
              },
            },
          },
        },
      } as never,
      channel: "discord",
      accountId: "ops",
    });

    expect(scoped.allowedPaths).toEqual(
      new Set(["channels.discord.token", "channels.discord.accounts.ops.token"]),
    );
  });

  it("keeps account-scoped allowedPaths as an empty set when scoped target paths are absent", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {
        channels: {
          discord: {
            accounts: {
              ops: { enabled: true },
            },
          },
        },
      } as never,
      channel: "custom-plugin-channel-without-secret-targets",
      accountId: "ops",
    });

    expect(scoped.allowedPaths).toEqual(new Set());
  });
});
