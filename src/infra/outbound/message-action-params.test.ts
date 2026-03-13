import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaParams,
} from "./message-action-params.js";

const cfg = {} as OpenClawConfig;
const maybeIt = process.platform === "win32" ? it.skip : it;

describe("message action sandbox media hydration", () => {
  maybeIt("rejects symlink retarget escapes after sandbox media normalization", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-sandbox-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-outside-"));
    try {
      const insideDir = path.join(sandboxRoot, "inside");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "note.txt"), "INSIDE_SECRET", "utf8");
      await fs.writeFile(path.join(outsideRoot, "note.txt"), "OUTSIDE_SECRET", "utf8");

      const slotLink = path.join(sandboxRoot, "slot");
      await fs.symlink(insideDir, slotLink);

      const args: Record<string, unknown> = {
        media: "slot/note.txt",
      };
      const mediaPolicy = {
        mode: "sandbox",
        sandboxRoot,
      } as const;

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy,
      });

      await fs.rm(slotLink, { recursive: true, force: true });
      await fs.symlink(outsideRoot, slotLink);

      await expect(
        hydrateAttachmentParamsForAction({
          cfg,
          channel: "slack",
          args,
          action: "sendAttachment",
          mediaPolicy,
        }),
      ).rejects.toThrow(/outside workspace root|outside/i);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe("message action attachment filename inference", () => {
  it("strips Windows-style path segments from encoded media URLs", async () => {
    const args: Record<string, unknown> = {
      media: "https://example.com/uploads/..%5Csecret.txt?sig=123",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "slack",
      args,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.filename).toBe("secret.txt");
  });

  it("strips Windows-style path segments from raw media hints", async () => {
    const args: Record<string, unknown> = {
      media: "..\\private\\voice-note.m4a#fragment",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "slack",
      args,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.filename).toBe("voice-note.m4a");
  });
});
