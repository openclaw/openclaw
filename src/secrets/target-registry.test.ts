import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import { getCoreSecretTargetRegistry } from "./target-registry-data.js";
import {
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
} from "./target-registry.js";

describe("secret target registry", () => {
  it("supports filtered discovery by target ids", () => {
    const config = {
      ...buildTalkTestProviderConfig({ source: "env", provider: "default", id: "TALK_API_KEY" }),
      gateway: {
        remote: {
          token: { source: "env" as const, provider: "default", id: "REMOTE_TOKEN" },
        },
      },
    } satisfies OpenClawConfig;

    const targets = discoverConfigSecretTargetsByIds(config, new Set(["talk.providers.*.apiKey"]));

    expect(targets).toHaveLength(1);
    expect(targets[0]?.entry?.id).toBe("talk.providers.*.apiKey");
    expect(targets[0]?.providerId).toBe(TALK_TEST_PROVIDER_ID);
    expect(targets[0]?.path).toBe(TALK_TEST_PROVIDER_API_KEY_PATH);
  });

  it("discovers core mcp env and header SecretRef targets", () => {
    const config = {
      mcp: {
        servers: {
          "mission-control": {
            env: {
              MC_API_KEY: { source: "env" as const, provider: "default", id: "MC_API_KEY" },
            },
            headers: {
              Authorization: {
                source: "env" as const,
                provider: "default",
                id: "REMOTE_MCP_AUTH",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const targets = discoverConfigSecretTargetsByIds(
      config,
      new Set(["mcp.servers.*.env.*", "mcp.servers.*.headers.*"]),
    ).map((target) => target.path);

    expect(targets).toEqual([
      "mcp.servers.mission-control.env.MC_API_KEY",
      "mcp.servers.mission-control.headers.Authorization",
    ]);
  });

  it("discovers generic core mcp env and header paths from the registry", () => {
    const config = {
      mcp: {
        servers: {
          "mission-control": {
            env: {
              MC_URL: { source: "env" as const, provider: "default", id: "MC_URL" },
              MC_API_KEY: { source: "env" as const, provider: "default", id: "MC_API_KEY" },
            },
            headers: {
              "X-Feature-Flag": {
                source: "env" as const,
                provider: "default",
                id: "FEATURE_FLAG",
              },
              Authorization: {
                source: "env" as const,
                provider: "default",
                id: "REMOTE_MCP_AUTH",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const targets = discoverConfigSecretTargetsByIds(
      config,
      new Set(["mcp.servers.*.env.*", "mcp.servers.*.headers.*"]),
    ).map((target) => target.path);

    expect(targets).toEqual([
      "mcp.servers.mission-control.env.MC_URL",
      "mcp.servers.mission-control.env.MC_API_KEY",
      "mcp.servers.mission-control.headers.X-Feature-Flag",
      "mcp.servers.mission-control.headers.Authorization",
    ]);
  });

  it("resolves config targets by exact path including sibling ref metadata", () => {
    const target = resolveConfigSecretTargetByPath(["channels", "googlechat", "serviceAccount"]);

    expect(target).not.toBeNull();
    expect(target?.entry?.id).toBe("channels.googlechat.serviceAccount");
    expect(target?.refPathSegments).toEqual(["channels", "googlechat", "serviceAccountRef"]);
  });

  it("returns null when no config target path matches", () => {
    const target = resolveConfigSecretTargetByPath(["gateway", "auth", "mode"]);

    expect(target).toBeNull();
  });

  it("derives bundled web provider api key target paths from plugin manifests", () => {
    const coreTargetIds = new Set(getCoreSecretTargetRegistry().map((entry) => entry.id));
    expect(coreTargetIds.has("plugins.entries.exa.config.webSearch.apiKey")).toBe(false);
    expect(coreTargetIds.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(false);

    const target = resolveConfigSecretTargetByPath([
      "plugins",
      "entries",
      "exa",
      "config",
      "webSearch",
      "apiKey",
    ]);

    expect(target).not.toBeNull();
    expect(target?.entry?.id).toBe("plugins.entries.exa.config.webSearch.apiKey");

    const fetchTarget = resolveConfigSecretTargetByPath([
      "plugins",
      "entries",
      "firecrawl",
      "config",
      "webFetch",
      "apiKey",
    ]);
    expect(fetchTarget).not.toBeNull();
    expect(fetchTarget?.entry?.id).toBe("plugins.entries.firecrawl.config.webFetch.apiKey");
  });

  it("derives bundled plugin SecretInput contract target paths from plugin manifests", () => {
    const coreTargetIds = new Set(getCoreSecretTargetRegistry().map((entry) => entry.id));
    expect(coreTargetIds.has("plugins.entries.voice-call.config.twilio.authToken")).toBe(false);

    const target = resolveConfigSecretTargetByPath([
      "plugins",
      "entries",
      "voice-call",
      "config",
      "tts",
      "providers",
      "elevenlabs",
      "apiKey",
    ]);

    expect(target).not.toBeNull();
    expect(target?.entry?.id).toBe("plugins.entries.voice-call.config.tts.providers.*.apiKey");
  });

  it("resolves core mcp env target paths", () => {
    const target = resolveConfigSecretTargetByPath([
      "mcp",
      "servers",
      "mission-control",
      "env",
      "MC_API_KEY",
    ]);

    expect(target).not.toBeNull();
    expect(target?.entry?.id).toBe("mcp.servers.*.env.*");
  });

  it("resolves generic core mcp env and header paths as secret targets", () => {
    const envTarget = resolveConfigSecretTargetByPath([
      "mcp",
      "servers",
      "mission-control",
      "env",
      "MC_URL",
    ]);
    const headerTarget = resolveConfigSecretTargetByPath([
      "mcp",
      "servers",
      "mission-control",
      "headers",
      "X-Feature-Flag",
    ]);

    expect(envTarget?.entry?.id).toBe("mcp.servers.*.env.*");
    expect(headerTarget?.entry?.id).toBe("mcp.servers.*.headers.*");
  });
});
