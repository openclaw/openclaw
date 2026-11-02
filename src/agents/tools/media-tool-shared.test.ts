import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { assertLocalMediaAllowed } from "../../media/local-media-access.js";
import { getMediaDir } from "../../media/store.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createSandboxFsBridge } from "../sandbox/fs-bridge.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createMediaGenerateProviderListActionResult } from "./media-generate-tool-actions-shared.js";
import {
  hasGenerationToolAvailability,
  hasGenerationToolAvailabilityAsync,
  isCapabilityProviderConfigured,
  loadMediaToolReferences,
  resolveGenerateAction,
  resolveCapabilityModelConfigForTool,
  resolveMediaToolReferenceAccess,
  resolveMediaToolSandboxConfig,
} from "./media-tool-shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

const workspaceDir = path.join("/tmp", "openclaw-media-workspace");
function resolveReference(
  input: string,
  options: Partial<Parameters<typeof resolveMediaToolReferenceAccess>[0]> = {},
) {
  return resolveMediaToolReferenceAccess({ input, isDataUrl: false, workspaceDir, ...options });
}

function asyncProvider(id: string, defaultModel: string, aliases?: string[]) {
  return {
    id,
    defaultModel,
    aliases,
    isConfigured: () => {
      throw new Error("sync credentials must not run");
    },
    isConfiguredAsync: async () => true,
  };
}

it.each([
  [{}, "generate"],
  [{ action: "   " }, "generate"],
  [{ action: 1 }, "generate"],
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

describe("resolveMediaToolLocalRoots", () => {
  it.each([true, false])(
    "adds host-owned attachment roots (workspaceOnly=%s)",
    async (workspaceOnly) => {
      const attachmentRoot = path.join("/tmp", "openclaw-subagent-attachments");
      const { localRoots } = await resolveReference(path.join(attachmentRoot, "receipt.png"), {
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

  it.each([
    { name: "host reads allowed", fsPolicy: { workspaceOnly: false }, allowed: true },
    { name: "workspace only", fsPolicy: { workspaceOnly: true }, allowed: false },
    { name: "no policy", fsPolicy: undefined, allowed: false },
  ])("admits host files read may open ($name)", async ({ fsPolicy, allowed }) => {
    const hostDir = tempDirs.make("openclaw-host-image-");
    const imagePath = path.join(hostDir, "screenshot.png");
    await fs.writeFile(imagePath, "png");
    const { resolvedPath, localRoots } = await resolveReference(imagePath, { fsPolicy });
    const access = assertLocalMediaAllowed(expectDefined(resolvedPath, "path"), localRoots);
    await (allowed
      ? expect(access).resolves.toBeUndefined()
      : expect(access).rejects.toThrow(/not under an allowed directory/));
  });

  it("admits only the declared attachment mount in workspace-only sandboxes", async () => {
    const root = workspaceDir;
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
      resolveReference("/openclaw/attachments/receipt.png", { sandbox, workspaceDir: undefined }),
    ).resolves.toMatchObject({ resolvedPath: path.join(hostPath, "receipt.png") });
  });

  it("does not widen default local roots from media sources", async () => {
    const stateDir = path.join("/tmp", "openclaw-media-tool-roots-state");
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";

    const { localRoots } = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      resolveReference(path.join(picturesDir, "photo.png"), {
        workspaceDir: path.join(stateDir, "workspace-agent"),
      }),
    );

    const normalizedRoots = localRoots.map(normalizeHostPath);
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-agent")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(picturesDir));
    expect(normalizedRoots).not.toContain(normalizeHostPath("/"));
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
    const result = resolveReference(input, { isDataUrl, workspaceDir: process.cwd() });
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

it("orders async provider defaults by canonical aliases without synchronous credentials", async () => {
  expect(
    await resolveCapabilityModelConfigForTool({
      cfg: {
        agents: { defaults: { model: { primary: "media-alias/gpt-5.5" } } },
      },
      providers: [
        asyncProvider("fal", "fal-ai/minimax/video-01-live"),
        asyncProvider("openai", "sora-2", ["media-alias"]),
      ],
    }),
  ).toEqual({
    primary: "openai/sora-2",
    fallbacks: ["fal/fal-ai/minimax/video-01-live"],
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
  ])("honors $name", async ({ cfg, isConfigured, expected }) => {
    const provider = { id: "local-image", defaultModel: "workflow", isConfigured };
    const params = {
      cfg,
      providers: [provider],
      providerKey: "imageGenerationProviders" as const,
    };
    expect([
      hasGenerationToolAvailability(params),
      await hasGenerationToolAvailabilityAsync(params),
    ]).toEqual([expected, expected]);
    if (cfg && isConfigured) {
      expect(isCapabilityProviderConfigured({ ...params, provider })).toBe(false);
      expect(await resolveCapabilityModelConfigForTool(params)).toBeNull();
    }
  });
});

it("awaits provider readiness and reports an unavailable async provider accurately", async () => {
  const isConfigured = vi.fn(() => {
    throw new Error("sync credentials must not run");
  });
  const result = await createMediaGenerateProviderListActionResult({
    kind: "image_generation",
    emptyText: "none",
    providers: [
      {
        id: "async-images",
        capabilities: {},
        isConfigured,
        isConfiguredAsync: async () => false,
      },
    ],
    listModes: () => ["generate"],
    summarizeCapabilities: () => "",
  });
  expect(result.details.providers).toEqual([
    expect.objectContaining({ id: "async-images", configured: false }),
  ]);
  expect(result.content[0]?.text).toContain("configured: no");
  expect(isConfigured).not.toHaveBeenCalled();
});
