// Command secret target import tests cover lazy import safety for secret target metadata.
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";

function secretTarget(
  id: string,
  overrides: {
    targetType?: string;
    pathPattern?: string;
    refPathPattern?: string;
    secretShape?: "secret_input" | "sibling_ref";
  } = {},
) {
  return {
    id,
    targetType: id,
    configFile: "openclaw.json",
    pathPattern: id,
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    ...overrides,
  };
}

describe("command secret targets module import", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("can resolve configured-channel status targets without the full registry", async () => {
    const listSecretTargetRegistryEntries = vi.fn(() => {
      throw new Error("registry touched too early");
    });
    const listReadOnlyChannelPluginsForConfig = vi.fn(() => [
      {
        id: "telegram",
        secrets: {
          secretTargetRegistryEntries: [
            secretTarget("channels.telegram.botToken"),
            secretTarget("channels.telegram.gatewayToken", {
              targetType: "gateway.auth.token",
              pathPattern: "gateway.auth.token",
            }),
            secretTarget("channels.telegram.gatewayTokenRef", {
              pathPattern: "channels.telegram.gatewayToken",
              refPathPattern: "gateway.auth.token",
              secretShape: "sibling_ref",
            }),
            secretTarget("channels.discord.token"),
          ],
        },
      },
      {
        id: "external-chat",
        secrets: {
          secretTargetRegistryEntries: [secretTarget("channels.external-chat.token")],
        },
      },
    ]);

    vi.doMock("../secrets/target-registry.js", () => ({
      discoverConfigSecretTargetsByIds: vi.fn(() => []),
      listSecretTargetRegistryEntries,
    }));
    vi.doMock("../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig,
    }));

    const mod = await import("./command-secret-targets.js");
    const targets = mod.getStatusCommandSecretTargetIds({
      channels: {
        "external-chat": { token: "configured" },
        telegram: { botToken: "123456:ABCDEF" },
      },
    });

    expect(targets.has("channels.external-chat.token")).toBe(true);
    expect(targets.has("channels.telegram.botToken")).toBe(true);
    expect(targets.has("channels.discord.token")).toBe(false);
    expect(targets.has("channels.telegram.gatewayToken")).toBe(false);
    expect(targets.has("channels.telegram.gatewayTokenRef")).toBe(false);
    expect(targets.has("gateway.auth.token")).toBe(true);
    expect(targets.has("gateway.auth.password")).toBe(true);
    expect(targets.has("gateway.remote.token")).toBe(true);
    expect(targets.has("gateway.remote.password")).toBe(true);
    expect(targets.has("memory.search.remote.apiKey")).toBe(true);
    const pluginCall = listReadOnlyChannelPluginsForConfig.mock.calls[0] as unknown as
      | [unknown, { includePersistedAuthState?: boolean }]
      | undefined;
    expect(typeof pluginCall?.[0]).toBe("object");
    expect(pluginCall?.[1]?.includePersistedAuthState).toBe(false);
    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
  });
});
