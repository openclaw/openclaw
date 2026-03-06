import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaParams,
  resolveSlackAutoThreadId,
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

const baseContext = {
  replyToMode: "all" as const,
  currentThreadTs: "1700000000.111111",
} as const;

describe("resolveSlackAutoThreadId", () => {
  describe("channel targets", () => {
    it("returns threadTs when channel target matches", () => {
      const result = resolveSlackAutoThreadId({
        to: "channel:C0AC3LUJQQM",
        toolContext: { ...baseContext, currentChannelId: "C0AC3LUJQQM" },
      });
      expect(result).toBe("1700000000.111111");
    });

    it("returns undefined when channel target does not match", () => {
      const result = resolveSlackAutoThreadId({
        to: "channel:CDIFFERENT",
        toolContext: { ...baseContext, currentChannelId: "C0AC3LUJQQM" },
      });
      expect(result).toBeUndefined();
    });
  });

  describe("DM targets (user: prefix)", () => {
    it("returns threadTs when DM target matches stored user: currentChannelId", () => {
      // This is the regression case: agent in a DM thread sends media via message tool.
      // currentChannelId is stored as "user:U0AC3LBA08M" (from buildSlackThreadingToolContext),
      // and the message tool targets the same user.
      const result = resolveSlackAutoThreadId({
        to: "user:U0AC3LBA08M",
        toolContext: { ...baseContext, currentChannelId: "user:U0AC3LBA08M" },
      });
      expect(result).toBe("1700000000.111111");
    });

    it("returns undefined when DM target does not match currentChannelId", () => {
      const result = resolveSlackAutoThreadId({
        to: "user:UDIFFERENT",
        toolContext: { ...baseContext, currentChannelId: "user:U0AC3LBA08M" },
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined when agent is in a DM thread but targets a different channel", () => {
      const result = resolveSlackAutoThreadId({
        to: "channel:CSOMECHANNEL",
        toolContext: { ...baseContext, currentChannelId: "user:U0AC3LBA08M" },
      });
      expect(result).toBeUndefined();
    });
  });

  describe("replyToMode gating", () => {
    it("returns undefined when replyToMode is off", () => {
      const result = resolveSlackAutoThreadId({
        to: "user:U0AC3LBA08M",
        toolContext: {
          replyToMode: "off",
          currentThreadTs: "1700000000.111111",
          currentChannelId: "user:U0AC3LBA08M",
        },
      });
      expect(result).toBeUndefined();
    });

    it("returns threadTs on first call with replyToMode first", () => {
      const hasRepliedRef = { value: false };
      const result = resolveSlackAutoThreadId({
        to: "user:U0AC3LBA08M",
        toolContext: {
          replyToMode: "first",
          currentThreadTs: "1700000000.111111",
          currentChannelId: "user:U0AC3LBA08M",
          hasRepliedRef,
        },
      });
      expect(result).toBe("1700000000.111111");
    });

    it("returns undefined on subsequent calls with replyToMode first after hasReplied", () => {
      const result = resolveSlackAutoThreadId({
        to: "user:U0AC3LBA08M",
        toolContext: {
          replyToMode: "first",
          currentThreadTs: "1700000000.111111",
          currentChannelId: "user:U0AC3LBA08M",
          hasRepliedRef: { value: true },
        },
      });
      expect(result).toBeUndefined();
    });
  });

  describe("missing context", () => {
    it("returns undefined when toolContext is absent", () => {
      expect(resolveSlackAutoThreadId({ to: "user:U0AC3LBA08M" })).toBeUndefined();
    });

    it("returns undefined when currentThreadTs is absent", () => {
      const result = resolveSlackAutoThreadId({
        to: "user:U0AC3LBA08M",
        toolContext: { replyToMode: "all", currentChannelId: "user:U0AC3LBA08M" },
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined when currentChannelId is absent", () => {
      const result = resolveSlackAutoThreadId({
        to: "user:U0AC3LBA08M",
        toolContext: { replyToMode: "all", currentThreadTs: "1700000000.111111" },
      });
      expect(result).toBeUndefined();
    });
  });
});
