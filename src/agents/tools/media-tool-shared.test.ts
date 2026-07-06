// Shared media tool tests cover root separation and provider availability for
// generation/understanding tools.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withEnv } from "../../test-utils/env.js";
import {
  hasGenerationToolAvailability,
  isCapabilityProviderConfigured,
  readBooleanToolParam,
  resolveMediaToolInboundRoots,
  resolveCapabilityModelConfigForTool,
  resolveMediaToolLocalRoots,
} from "./media-tool-shared.js";

// Keep media-tool-shared tests focused on root separation; channel-inbound
// tests cover the real bundled contract loader.
vi.mock("../../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRootsForChannel: (params: {
    cfg?: OpenClawConfig;
    channelId?: string | null;
    accountId?: string | null;
  }) => {
    const channelId = params.channelId?.trim();
    if (!channelId) {
      return undefined;
    }

    const channelConfig = params.cfg?.channels?.[channelId];
    const accountConfig = params.accountId
      ? channelConfig?.accounts?.[params.accountId]
      : undefined;
    const roots = [
      ...(accountConfig?.attachmentRoots ?? []),
      ...(channelConfig?.attachmentRoots ?? []),
    ];
    return channelId === "imessage" ? [...roots, "/Users/*/Library/Messages/Attachments"] : roots;
  },
}));

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

describe("readBooleanToolParam", () => {
  it("parses booleans and true/false string tokens", () => {
    expect(readBooleanToolParam({ audio: true }, "audio")).toBe(true);
    expect(readBooleanToolParam({ audio: " FALSE " }, "audio")).toBe(false);
    expect(readBooleanToolParam({ audio: "yes" }, "audio")).toBeUndefined();
  });
});

describe("resolveMediaToolLocalRoots", () => {
  it("does not widen default local roots from media sources", () => {
    const stateDir = path.join("/tmp", "openclaw-media-tool-roots-state");
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";
    const moviesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Movies" : "/Users/peter/Movies";

    const roots = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      resolveMediaToolLocalRoots(path.join(stateDir, "workspace-agent"), undefined, [
        path.join(picturesDir, "photo.png"),
        pathToFileURL(path.join(moviesDir, "clip.mp4")).href,
        "/top-level-file.png",
      ]),
    );

    const normalizedRoots = roots.map(normalizeHostPath);
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-agent")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(picturesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath(moviesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath("/"));
  });

  it("keeps channel inbound attachment roots separate from local roots", () => {
    // Inbound channel roots may include broad chat attachment folders; keep them
    // out of local filesystem allowlists unless the channel context asks.
    const accountRoot = path.join("/tmp", "openclaw-imessage-work");
    const sharedRoot = path.join("/tmp", "openclaw-imessage-shared");
    const cfg = {
      channels: {
        imessage: {
          attachmentRoots: [sharedRoot],
          accounts: {
            work: {
              attachmentRoots: [accountRoot],
            },
          },
        },
      },
    };

    const withoutChannel = resolveMediaToolLocalRoots(undefined, { cfg });
    expect(withoutChannel.map(normalizeHostPath)).not.toContain(normalizeHostPath(accountRoot));
    expect(withoutChannel.map(normalizeHostPath)).not.toContain(normalizeHostPath(sharedRoot));
    expect(resolveMediaToolInboundRoots({ cfg })).toEqual([]);

    const withImessage = resolveMediaToolLocalRoots(undefined, {
      cfg,
      channelId: "imessage",
      accountId: "work",
    });
    expect(withImessage.map(normalizeHostPath)).not.toContain(normalizeHostPath(accountRoot));
    expect(withImessage.map(normalizeHostPath)).not.toContain(normalizeHostPath(sharedRoot));
    expect(
      resolveMediaToolInboundRoots({
        cfg,
        channelId: "imessage",
        accountId: "work",
      }),
    ).toEqual([accountRoot, sharedRoot, "/Users/*/Library/Messages/Attachments"]);
  });
});

describe("hasGenerationToolAvailability", () => {
  it("accepts config-backed custom provider auth for generation providers", () => {
    const cfg = {
      models: {
        providers: {
          "custom-image": {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-configured", // pragma: allowlist secret
            models: [],
          },
        },
      },
    };

    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        cfg,
        providers: [{ id: "custom-image", defaultModel: "workflow" }],
      }),
    ).toBe(true);
  });

  it("preserves a provider-specific not-configured result over generic config auth", () => {
    const cfg = {
      models: {
        providers: {
          "workflow-image": {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-configured", // pragma: allowlist secret
            models: [],
          },
        },
      },
    };
    const provider = {
      id: "workflow-image",
      defaultModel: "workflow",
      isConfigured: () => false,
    };

    expect(
      isCapabilityProviderConfigured({
        providers: [provider],
        provider,
        cfg,
      }),
    ).toBe(false);
    expect(
      resolveCapabilityModelConfigForTool({
        cfg,
        providers: [provider],
      }),
    ).toBeNull();
  });

  it("allows generation tools for runtime providers configured without auth", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        providers: [
          {
            id: "local-image",
            defaultModel: "workflow",
            isConfigured: () => true,
          },
        ],
      }),
    ).toBe(true);
  });

  it("omits generation tools when runtime providers are not configured", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        providers: [
          {
            id: "local-image",
            defaultModel: "workflow",
            isConfigured: () => false,
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps explicit model config sufficient for generation tool registration", () => {
    const loadProviders = vi.fn(() => []);

    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        modelConfig: { primary: "local-image/workflow" },
        providers: loadProviders,
      }),
    ).toBe(true);
    expect(loadProviders).not.toHaveBeenCalled();
  });

  it("checks configured runtime providers against the supplied auth store", () => {
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        authStore: {
          version: 1,
          profiles: {
            "local-image:default": {
              provider: "local-image",
              type: "api_key",
              key: "test",
            },
          },
        },
        providers: [{ id: "local-image", defaultModel: "workflow" }],
      }),
    ).toBe(true);
  });
});
