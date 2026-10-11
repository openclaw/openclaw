import { afterEach, describe, expect, it } from "vitest";
import { resolveResponsePrefix } from "../../agents/identity.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { resolveEffectiveBlockStreamingConfig } from "../../auto-reply/reply/block-streaming.js";
import { resolveChannelGroups } from "../../config/channel-groups.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindPluginRegistryGatewayOwner } from "../../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { ChannelPlugin } from "./types.plugin.js";

const { whatsappPlugin } = await loadBundledPluginFacade<{ whatsappPlugin: ChannelPlugin }>({
  pluginId: "whatsapp",
  artifactBasename: "channel-plugin-api",
});

afterEach(() => resetPluginRuntimeStateForTest());

function config(): OpenClawConfig {
  return {
    messages: { responsePrefix: "[GLOBAL]" },
    channels: {
      whatsapp: {
        responsePrefix: "[ROOT]",
        textChunkLimit: 4000,
        streaming: { chunkMode: "newline", block: { coalesce: { idleMs: 7, maxChars: 100 } } },
        groups: { "*": { requireMention: true } },
        accounts: {
          default: {
            responsePrefix: "[SHARED]",
            textChunkLimit: 1200,
            streaming: { block: { coalesce: { minChars: 15 } } },
            groups: { "*": { requireMention: false } },
          },
          work: {},
        },
      },
    },
  };
}

function registration() {
  return createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin: whatsappPlugin }]);
}

function assertSharedSettings(cfg: OpenClawConfig) {
  expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "work" })).toBe(
    "[SHARED]",
  );
  expect(resolveTextChunkLimit(cfg, "whatsapp", "work")).toBe(1200);
  expect(resolveChunkMode(cfg, "whatsapp", "work")).toBe("length");
  expect(
    resolveEffectiveBlockStreamingConfig({ cfg, provider: "whatsapp", accountId: "work" })
      .coalescing,
  ).toMatchObject({ minChars: 15, maxChars: 1200, idleMs: 1000 });
  expect(resolveChannelGroups(cfg, "whatsapp", "work")).toEqual({ "*": { requireMention: false } });
}

describe("account-selected messaging through core consumers", () => {
  it("uses shared account defaults without modifying canonical config", () => {
    const cfg = config();
    const before = structuredClone(cfg);
    setActivePluginRegistry(registration());
    assertSharedSettings(cfg);
    expect(cfg).toEqual(before);
  });

  it("retains the admitting config owner in a filtered turn registry", () => {
    const cfg = config();
    const admitted = registration();
    const owner = { current: () => admitted };
    bindPluginRegistryGatewayOwner(admitted, owner);
    const turn = createTestRegistry();
    bindPluginRegistryGatewayOwner(turn, owner, admitted);
    setActivePluginRegistry(createTestRegistry());
    withPluginRuntimeRegistryScope(turn, () => assertSharedSettings(cfg));
  });

  it("preserves named overrides and whole streaming-object replacement", () => {
    const cfg = config();
    cfg.channels!.whatsapp!.accounts!.work = {
      responsePrefix: "",
      textChunkLimit: 900,
      streaming: { chunkMode: "newline" },
      groups: {},
    };
    setActivePluginRegistry(registration());
    expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "work" })).toBe("");
    expect(resolveTextChunkLimit(cfg, "whatsapp", "work")).toBe(900);
    expect(resolveChunkMode(cfg, "whatsapp", "work")).toBe("newline");
    expect(
      resolveEffectiveBlockStreamingConfig({ cfg, provider: "whatsapp", accountId: "work" })
        .coalescing,
    ).toMatchObject({ maxChars: 900, idleMs: 1000 });
    expect(resolveChannelGroups(cfg, "whatsapp", "work")).toEqual({});
  });

  it("preserves the single-account empty group-map contract", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: false } },
          accounts: { work: { groups: {} } },
        },
      },
    };
    setActivePluginRegistry(registration());
    expect(resolveChannelGroups(cfg, "whatsapp", "work")).toEqual({
      "*": { requireMention: false },
    });
  });
});
