import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaStore from "../../media/store.js";
import {
  hydrateBufferedSendParams,
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaParams,
} from "./message-action-params.js";

const cfg = {} as OpenClawConfig;
const maybeIt = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("send buffer hydration", () => {
  it("materializes host buffer payloads into media", async () => {
    const saveSpy = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      id: "test.txt",
      path: "/tmp/test.txt",
      size: 5,
      contentType: "text/plain",
    });
    const args: Record<string, unknown> = {
      buffer: Buffer.from("hello").toString("base64"),
      filename: "test.txt",
      contentType: "text/plain",
    };

    await hydrateBufferedSendParams({
      cfg,
      channel: "slack",
      args,
      mediaPolicy: { mode: "host", localRoots: ["/tmp"] },
    });

    expect(saveSpy).toHaveBeenCalledWith(
      Buffer.from("hello"),
      "text/plain",
      "outbound",
      5,
      "test.txt",
    );
    expect(args.media).toBe("/tmp/test.txt");
    expect(args.filename).toBe("test.txt");
    expect(args.contentType).toBe("text/plain");
  });

  it("does not materialize buffer when media is already present", async () => {
    const saveSpy = vi.spyOn(mediaStore, "saveMediaBuffer");
    const args: Record<string, unknown> = {
      media: "/tmp/existing.txt",
      buffer: Buffer.from("hello").toString("base64"),
      filename: "test.txt",
    };

    await hydrateBufferedSendParams({
      cfg,
      channel: "slack",
      args,
      mediaPolicy: { mode: "host", localRoots: ["/tmp"] },
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(args.media).toBe("/tmp/existing.txt");
  });

  it.each(["zalo", "line", "irc", "nextcloud-talk", "synology-chat", "tlon"] as const)(
    "skips local media materialization for URL-only send channel %s",
    async (channel) => {
      const saveSpy = vi.spyOn(mediaStore, "saveMediaBuffer");
      const args: Record<string, unknown> = {
        buffer: Buffer.from("hello").toString("base64"),
        filename: "test.txt",
        contentType: "text/plain",
      };

      await hydrateBufferedSendParams({
        cfg,
        channel,
        args,
        mediaPolicy: { mode: "host", localRoots: ["/tmp"] },
      });

      expect(saveSpy).not.toHaveBeenCalled();
      expect(args.media).toBeUndefined();
      expect(args.buffer).toBe(Buffer.from("hello").toString("base64"));
    },
  );

  maybeIt("materializes sandbox buffer payloads into sandbox outbound", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-buffer-sandbox-"));
    try {
      const args: Record<string, unknown> = {
        buffer: Buffer.from("hello").toString("base64"),
        filename: "note.txt",
        contentType: "text/plain",
      };

      await hydrateBufferedSendParams({
        cfg,
        channel: "slack",
        args,
        mediaPolicy: { mode: "sandbox", sandboxRoot },
      });

      const mediaPath = String(args.media);
      expect(mediaPath).toBe(path.join(sandboxRoot, "outbound", "note.txt"));
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hello");
      expect(args.filename).toBe("note.txt");
      expect(args.contentType).toBe("text/plain");
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });
});
