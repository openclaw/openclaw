// Shared media tool tests cover root separation, provider availability, and
// model-registry normalization for generation/understanding tools.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getMediaDir } from "../../media/store.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createSandboxFsBridge } from "../sandbox/fs-bridge.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import {
  hasGenerationToolAvailability,
  isCapabilityProviderConfigured,
  loadMediaToolReferences,
  resolveGenerateAction,
  resolveMediaToolInboundRoots,
  resolveCapabilityModelConfigForTool,
  resolveMediaToolReferenceAccess,
  resolveMediaToolSandboxConfig,
} from "./media-tool-shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

describe("resolveGenerateAction", () => {
  it.each([
    [{}, "generate"],
    [{ action: "   " }, "generate"],
    [{ action: 1 }, "generate"],
    [{ action: "generate" }, "generate"],
    [{ action: " STATUS " }, "status"],
    [{ action: "list" }, "list"],
    [{ action: "invalid" }, /^action must be "generate", "status", or "list"$/],
  ] as const)("resolves or rejects %j", (args, expected) => {
    if (typeof expected === "string") {
      expect(resolveGenerateAction(args)).toBe(expected);
    } else {
      expect(() => resolveGenerateAction(args)).toThrowError(expected);
    }
  });
});

describe("resolveMediaToolLocalRoots", () => {
  it.each([true, false])(
    "adds host-owned attachment roots (workspaceOnly=%s)",
    async (workspaceOnly) => {
      const workspaceDir = path.join("/tmp", "openclaw-media-workspace");
      const attachmentRoot = path.join("/tmp", "openclaw-subagent-attachments");
      const { localRoots } = await resolveMediaToolReferenceAccess({
        input: path.join(attachmentRoot, "receipt.png"),
        isDataUrl: false,
        workspaceDir,
        fsPolicy: { workspaceOnly, readOnlyRoots: [attachmentRoot] },
      });
      if (workspaceOnly) {
        expect(localRoots.map(normalizeHostPath)).toEqual(
          [getMediaDir(), workspaceDir, attachmentRoot].map(normalizeHostPath),
        );
      } else {
        expect(localRoots.map(normalizeHostPath)).toContain(normalizeHostPath(attachmentRoot));
      }
    },
  );

  it("admits only the declared attachment mount in workspace-only sandboxes", async () => {
    const root = path.join("/tmp", "openclaw-media-workspace");
    const hostPath = path.join("/tmp", "openclaw-subagent-attachments");
    const mount = { hostPath, containerPath: "/openclaw/attachments" };
    const sandbox = resolveMediaToolSandboxConfig(
      {
        root,
        bridge: createSandboxFsBridge({
          sandbox: {
            ...createSandboxTestContext({
              overrides: {
                workspaceDir: root,
                agentWorkspaceDir: root,
                readOnlyResourceMounts: [mount],
              },
            }),
            backend: {
              runShellCommand: async () => {
                throw new Error("Path resolution must not execute backend commands");
              },
            },
          },
        }),
        readOnlyResourceMounts: [mount],
      },
      true,
    );

    await expect(
      resolveMediaToolReferenceAccess({
        input: "/openclaw/attachments/receipt.png",
        isDataUrl: false,
        sandbox,
      }),
    ).resolves.toMatchObject({ resolvedPath: path.join(hostPath, "receipt.png") });
  });

  it("does not widen default local roots from media sources", async () => {
    const stateDir = path.join("/tmp", "openclaw-media-tool-roots-state");
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";

    const { localRoots } = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      resolveMediaToolReferenceAccess({
        input: path.join(picturesDir, "photo.png"),
        isDataUrl: false,
        workspaceDir: path.join(stateDir, "workspace-agent"),
      }),
    );

    const normalizedRoots = localRoots.map(normalizeHostPath);
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-agent")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(picturesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath("/"));
  });

  it("keeps channel inbound attachment roots separate from local roots", async () => {
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

    const { localRoots } = await resolveMediaToolReferenceAccess({
      input: "relative/reference.png",
      isDataUrl: false,
    });
    expect(localRoots.map(normalizeHostPath)).not.toContain(normalizeHostPath(accountRoot));
    expect(localRoots.map(normalizeHostPath)).not.toContain(normalizeHostPath(sharedRoot));
    expect(resolveMediaToolInboundRoots({ cfg })).toEqual([]);
    expect(
      resolveMediaToolInboundRoots({
        cfg,
        channelId: "imessage",
        accountId: "work",
      }).map(normalizeHostPath),
    ).toEqual(
      [accountRoot, sharedRoot, "/Users/*/Library/Messages/Attachments"].map(normalizeHostPath),
    );
  });
});

describe("resolveMediaToolReferenceAccess", () => {
  const filePath = path.join(process.cwd(), "café reference image.png");
  it.each<{
    input: string;
    isDataUrl?: boolean;
    expected?: string | null;
    error?: RegExp | typeof URIError;
  }>([
    { input: pathToFileURL(filePath).href, expected: filePath },
    { input: "https://example.com/reference.png", expected: "https://example.com/reference.png" },
    { input: "media://inbound/a.png", expected: "media://inbound/a.png" },
    { input: "data:image/png;base64,cG5n", isDataUrl: true, expected: null },
    { input: "file://attacker/share.png", error: /remote hosts/i },
    { input: "file:///tmp/encoded%2Fseparator.png", error: /encode path separators/i },
    { input: "file:///tmp/malformed%ZZ.png", error: URIError },
  ])("resolves or rejects $input", async ({ input, isDataUrl = false, expected, error }) => {
    const result = resolveMediaToolReferenceAccess({
      input,
      isDataUrl,
      workspaceDir: process.cwd(),
    });
    if (error) {
      await expect(result).rejects.toThrow(error);
    } else {
      await expect(result).resolves.toMatchObject({ resolvedPath: expected });
    }
  });

  it.each(["image_generate", "music_generate"] as const)(
    "loads a producer-staged bare handle for %s references",
    async (toolName) => {
      const root = tempDirs.make("openclaw-media-tool-staged-");
      const stagedPath = "media/inbound/openclaw-staged-proof/input-file_upload.png";
      const fullPath = path.join(root, stagedPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(
        fullPath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const sandbox = resolveMediaToolSandboxConfig(
        {
          root,
          bridge: createHostSandboxFsBridge(root),
          stagedMediaPaths: new Map([["file_upload", stagedPath]]),
        },
        true,
      );

      const loaded = await loadMediaToolReferences({
        inputs: ["file_upload"],
        toolName,
        expectedKind: "image",
        sandbox,
        workspaceDir: root,
        maxBytes: 1024,
        mapMedia: (media) => media.buffer,
      });

      expect(loaded).toMatchObject([
        { resolvedInput: "file_upload", rewrittenFrom: "file_upload" },
      ]);
    },
  );
});

describe("resolveCapabilityModelConfigForTool", () => {
  it("uses explicit model config for selection and availability without loading providers", () => {
    const providers = vi.fn(() => {
      throw new Error("runtime provider list should not run for explicit model config");
    });
    const modelConfig = { primary: "qwen/wan2.6-t2v" };
    expect(resolveCapabilityModelConfigForTool({ modelConfig, providers })).toEqual(modelConfig);
    expect(
      hasGenerationToolAvailability({
        providerKey: "imageGenerationProviders",
        modelConfig,
        providers,
      }),
    ).toBe(true);
    expect(providers).not.toHaveBeenCalled();
  });

  it("orders auto-detected provider defaults by canonical aliases", () => {
    expect(
      resolveCapabilityModelConfigForTool({
        cfg: {
          agents: { defaults: { model: { primary: "media-alias/gpt-5.5" } } },
        },
        providers: [
          {
            id: "fal",
            defaultModel: "fal-ai/minimax/video-01-live",
            isConfigured: () => true,
          },
          {
            id: "openai",
            aliases: ["media-alias"],
            defaultModel: "sora-2",
            isConfigured: () => true,
          },
        ],
      }),
    ).toEqual({
      primary: "openai/sora-2",
      fallbacks: ["fal/fal-ai/minimax/video-01-live"],
    });
  });
});

describe("hasGenerationToolAvailability", () => {
  const configuredCredentials: OpenClawConfig = {
    models: {
      providers: {
        "local-image": { baseUrl: "https://example.com/v1", apiKey: "sk-configured", models: [] }, // pragma: allowlist secret
      },
    },
  };
  it.each<{
    name: string;
    cfg?: OpenClawConfig;
    isConfigured?: () => boolean;
    authStore?: Parameters<typeof hasGenerationToolAvailability>[0]["authStore"];
    expected: boolean;
  }>([
    { name: "config-backed auth", cfg: configuredCredentials, expected: true },
    {
      name: "provider denial overrides config auth",
      cfg: configuredCredentials,
      isConfigured: () => false,
      expected: false,
    },
    { name: "auth-free configured provider", isConfigured: () => true, expected: true },
    { name: "unconfigured provider", isConfigured: () => false, expected: false },
    {
      name: "supplied auth store",
      expected: true,
      authStore: {
        version: 1,
        profiles: {
          "local-image:default": { provider: "local-image", type: "api_key", key: "test" },
        },
      },
    },
  ])("honors $name", ({ cfg, isConfigured, authStore, expected }) => {
    const provider = { id: "local-image", defaultModel: "workflow", isConfigured };
    const params = { cfg, authStore, providers: [provider] };
    expect(
      hasGenerationToolAvailability({ ...params, providerKey: "imageGenerationProviders" }),
    ).toBe(expected);
    if (cfg && isConfigured) {
      expect(isCapabilityProviderConfigured({ ...params, provider })).toBe(false);
      expect(resolveCapabilityModelConfigForTool(params)).toBeNull();
    }
  });
});
