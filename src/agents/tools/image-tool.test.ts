import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedBridge } from "../test-helpers/unsafe-mounted-sandbox.js";
import { __testing, createImageTool, resolveImageModelConfigForTool } from "./image-tool.js";

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const ONE_PIXEL_GIF_B64 = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";

function createExplicitImageConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        imageModel: { primary: "openai/gpt-5.4-mini" },
      },
    },
  };
}

function requireImageTool<T>(tool: T | null | undefined): T {
  expect(tool).not.toBeNull();
  if (!tool) {
    throw new Error("expected image tool");
  }
  return tool;
}

function createRequiredImageTool(args: Parameters<typeof createImageTool>[0]) {
  return requireImageTool(createImageTool(args));
}

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-agent-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function withTempWorkspacePng(
  cb: (args: { workspaceDir: string; imagePath: string }) => Promise<void>,
) {
  const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-image-"));
  try {
    const workspaceDir = path.join(workspaceParent, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
    await cb({ workspaceDir, imagePath });
  } finally {
    await fs.rm(workspaceParent, { recursive: true, force: true });
  }
}

async function withTempSandboxState(
  run: (ctx: { stateDir: string; agentDir: string; sandboxRoot: string }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-sandbox-"));
  const agentDir = path.join(stateDir, "agent");
  const sandboxRoot = path.join(stateDir, "sandbox");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(sandboxRoot, { recursive: true });
  try {
    await run({ stateDir, agentDir, sandboxRoot });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("resolveImageModelConfigForTool", () => {
  it("returns explicit agents.defaults.imageModel when configured", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg = createExplicitImageConfig();
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5.4-mini",
      });
    });
  });

  it("requires agentDir when explicit imageModel enables the tool", () => {
    const cfg = createExplicitImageConfig();
    expect(() => createImageTool({ config: cfg })).toThrow(/requires agentDir/i);
  });

  it("keeps the tool available with native-vision models and updates description", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg = createExplicitImageConfig();
      const tool = createImageTool({ config: cfg, agentDir, modelHasVision: true });
      expect(tool).not.toBeNull();
      expect(tool?.description).toContain(
        "Only use this tool when images were NOT already provided",
      );
    });
  });
});

describe("image tool content-block return path", () => {
  it("returns prompt text plus an image content block for a single data URL", async () => {
    await withTempAgentDir(async (agentDir) => {
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy as typeof global.fetch;
      const tool = createRequiredImageTool({ config: createExplicitImageConfig(), agentDir });

      const result = await tool.execute("t1", {
        prompt: "Describe the image.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.content?.[0]).toEqual({ type: "text", text: "Describe the image." });
      const images = result.content?.filter((block) => block.type === "image") ?? [];
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect((images[0] as { data?: string }).data).toBe(ONE_PIXEL_PNG_B64);
      expect(result.details).toMatchObject({
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });
    });
  });

  it("returns multiple image content blocks for multi-image requests", async () => {
    await withTempAgentDir(async (agentDir) => {
      const tool = createRequiredImageTool({ config: createExplicitImageConfig(), agentDir });

      const result = await tool.execute("t1", {
        prompt: "Compare these images.",
        images: [
          `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
          `data:image/gif;base64,${ONE_PIXEL_GIF_B64}`,
        ],
      });

      expect(result.content?.[0]).toEqual({ type: "text", text: "Compare these images." });
      const images = result.content?.filter((block) => block.type === "image") ?? [];
      expect(images).toHaveLength(2);
      expect(images.map((block) => (block as { mimeType?: string }).mimeType)).toEqual([
        "image/png",
        "image/gif",
      ]);
      expect(result.details).toMatchObject({
        images: [
          { image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}` },
          { image: `data:image/gif;base64,${ONE_PIXEL_GIF_B64}` },
        ],
      });
    });
  });

  it("combines image + images, dedupes them, and preserves order", async () => {
    await withTempAgentDir(async (agentDir) => {
      const tool = createRequiredImageTool({ config: createExplicitImageConfig(), agentDir });

      const result = await tool.execute("t1", {
        prompt: "Compare these images.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        images: [
          `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
          `data:image/gif;base64,${ONE_PIXEL_GIF_B64}`,
          `data:image/gif;base64,${ONE_PIXEL_GIF_B64}`,
        ],
      });

      const images = result.content?.filter((block) => block.type === "image") ?? [];
      expect(images).toHaveLength(2);
      expect(result.details).toMatchObject({
        images: [
          { image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}` },
          { image: `data:image/gif;base64,${ONE_PIXEL_GIF_B64}` },
        ],
      });
    });
  });

  it("enforces maxImages before loading media", async () => {
    await withTempAgentDir(async (agentDir) => {
      const tool = createRequiredImageTool({ config: createExplicitImageConfig(), agentDir });

      const result = await tool.execute("t1", {
        prompt: "Compare these images.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        images: [`data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
        maxImages: 1,
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: "Too many images: 2 provided, maximum is 1. Please reduce the number of images.",
        },
      ]);
      expect(result.details).toMatchObject({
        error: "too_many_images",
        count: 2,
        max: 1,
      });
    });
  });

  it("returns a graceful error for unsupported pseudo-image references", async () => {
    await withTempAgentDir(async (agentDir) => {
      const tool = createRequiredImageTool({ config: createExplicitImageConfig(), agentDir });

      const result = await tool.execute("t1", {
        prompt: "Describe the image.",
        image: "image:0",
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: "Unsupported image reference: image:0. Use a file path, a file:// URL, a data: URL, or an http(s) URL.",
        },
      ]);
      expect(result.details).toMatchObject({
        error: "unsupported_image_reference",
        image: "image:0",
      });
    });
  });
});

describe("image tool local path handling", () => {
  it("still rejects temp workspace paths outside allowed local roots when workspaceOnly is off", async () => {
    await withTempWorkspacePng(async ({ imagePath }) => {
      await withTempAgentDir(async (agentDir) => {
        const tool = createRequiredImageTool({
          config: createExplicitImageConfig(),
          agentDir,
        });

        await expect(tool.execute("t1", { prompt: "Describe.", image: imagePath })).rejects.toThrow(
          /not under an allowed directory/i,
        );
      });
    });
  });

  it("resolves relative image paths against workspaceDir", async () => {
    await withTempWorkspacePng(async ({ workspaceDir }) => {
      const subdir = path.join(workspaceDir, "inbox");
      await fs.mkdir(subdir, { recursive: true });
      await fs.writeFile(
        path.join(subdir, "receipt.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );

      await withTempAgentDir(async (agentDir) => {
        const tool = createRequiredImageTool({
          config: createExplicitImageConfig(),
          agentDir,
          workspaceDir,
        });

        const result = await tool.execute("t1", {
          prompt: "Describe.",
          image: "inbox/receipt.png",
        });

        expect(result.content?.[0]).toEqual({ type: "text", text: "Describe." });
        const images = result.content?.filter((block) => block.type === "image") ?? [];
        expect(images).toHaveLength(1);
        expect(result.details).toMatchObject({
          image: path.join(workspaceDir, "inbox", "receipt.png"),
        });
      });
    });
  });

  it("allows workspace images when workspace root is explicit", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      await withTempAgentDir(async (agentDir) => {
        const tool = createRequiredImageTool({
          config: createExplicitImageConfig(),
          agentDir,
          workspaceDir,
        });

        const result = await tool.execute("t1", {
          prompt: "Describe.",
          image: imagePath,
        });

        expect(result.content?.[0]).toEqual({ type: "text", text: "Describe." });
        expect(result.content?.filter((block) => block.type === "image")).toHaveLength(1);
      });
    });
  });
});

describe("image tool sandbox handling", () => {
  it("sandboxes image paths like the read tool", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(
        path.join(sandboxRoot, "img.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );
      const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };
      const tool = createRequiredImageTool({
        config: createExplicitImageConfig(),
        agentDir,
        sandbox,
      });

      await expect(tool.execute("t1", { image: "https://example.com/a.png" })).rejects.toThrow(
        /Sandboxed image tool does not allow remote URLs/i,
      );

      await expect(tool.execute("t2", { image: "../escape.png" })).rejects.toThrow(
        /escapes sandbox root/i,
      );
    });
  });

  it("applies workspaceOnly to image paths in sandbox mode", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(
        path.join(agentDir, "secret.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );
      const imageTool = createRequiredImageTool({
        config: createExplicitImageConfig(),
        agentDir,
        sandbox: {
          root: sandboxRoot,
          bridge: createUnsafeMountedBridge({ root: sandboxRoot, agentHostRoot: agentDir }),
        },
        workspaceDir: sandboxRoot,
        fsPolicy: { workspaceOnly: true },
      });

      await expect(
        imageTool.execute("t2", {
          prompt: "Describe the image.",
          image: "/agent/secret.png",
        }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
    });
  });

  it("rewrites inbound absolute paths into sandbox media/inbound", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.mkdir(path.join(sandboxRoot, "media", "inbound"), { recursive: true });
      await fs.writeFile(
        path.join(sandboxRoot, "media", "inbound", "photo.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );

      const tool = createRequiredImageTool({
        config: createExplicitImageConfig(),
        agentDir,
        sandbox: { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) },
      });

      const result = await tool.execute("t1", {
        prompt: "Describe the image.",
        image: "@/Users/steipete/.openclaw/media/inbound/photo.png",
      });

      expect(result.details).toMatchObject({
        image: "/Users/steipete/.openclaw/media/inbound/photo.png",
        rewrittenFrom: "/Users/steipete/.openclaw/media/inbound/photo.png",
      });
      expect(result.content?.filter((block) => block.type === "image")).toHaveLength(1);
    });
  });
});

describe("image tool data URL support", () => {
  it("decodes base64 image data URLs", () => {
    const out = __testing.decodeDataUrl(`data:image/png;base64,${ONE_PIXEL_PNG_B64}`);
    expect(out.kind).toBe("image");
    expect(out.mimeType).toBe("image/png");
    expect(out.buffer.length).toBeGreaterThan(0);
  });

  it("rejects non-image data URLs", () => {
    expect(() => __testing.decodeDataUrl("data:text/plain;base64,SGVsbG8=")).toThrow(
      /Unsupported data URL type/i,
    );
  });
});
