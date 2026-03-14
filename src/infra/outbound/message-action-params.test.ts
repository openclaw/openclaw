import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaList,
  normalizeSandboxMediaParams,
  resolveAttachmentMediaPolicy,
  resolveSlackAutoThreadId,
  resolveTelegramAutoThreadId,
} from "./message-action-params.js";

const cfg = {} as OpenClawConfig;
const maybeIt = process.platform === "win32" ? it.skip : it;

function createToolContext(
  overrides: Partial<ChannelThreadingToolContext> = {},
): ChannelThreadingToolContext {
  return {
    currentChannelId: "C123",
    currentThreadTs: "thread-1",
    replyToMode: "all",
    ...overrides,
  };
}

describe("message action threading helpers", () => {
  it("resolves Slack auto-thread ids only for matching active channels", () => {
    expect(
      resolveSlackAutoThreadId({
        to: "#c123",
        toolContext: createToolContext(),
      }),
    ).toBe("thread-1");
    expect(
      resolveSlackAutoThreadId({
        to: "channel:C999",
        toolContext: createToolContext(),
      }),
    ).toBeUndefined();
    expect(
      resolveSlackAutoThreadId({
        to: "user:U123",
        toolContext: createToolContext(),
      }),
    ).toBeUndefined();
  });

  it("skips Slack auto-thread ids when reply mode or context blocks them", () => {
    expect(
      resolveSlackAutoThreadId({
        to: "C123",
        toolContext: createToolContext({
          replyToMode: "first",
          hasRepliedRef: { value: true },
        }),
      }),
    ).toBeUndefined();
    expect(
      resolveSlackAutoThreadId({
        to: "C123",
        toolContext: createToolContext({ replyToMode: "off" }),
      }),
    ).toBeUndefined();
    expect(
      resolveSlackAutoThreadId({
        to: "C123",
        toolContext: createToolContext({ currentThreadTs: undefined }),
      }),
    ).toBeUndefined();
  });

  it("resolves Telegram auto-thread ids for matching chats across target formats", () => {
    expect(
      resolveTelegramAutoThreadId({
        to: "telegram:group:-100123:topic:77",
        toolContext: createToolContext({
          currentChannelId: "tg:group:-100123",
        }),
      }),
    ).toBe("thread-1");
    expect(
      resolveTelegramAutoThreadId({
        to: "-100999:77",
        toolContext: createToolContext({
          currentChannelId: "-100123",
        }),
      }),
    ).toBeUndefined();
    expect(
      resolveTelegramAutoThreadId({
        to: "-100123",
        toolContext: createToolContext({ currentChannelId: undefined }),
      }),
    ).toBeUndefined();
  });
});

describe("message action media helpers", () => {
  it("prefers sandbox media policy when sandbox roots are non-blank", () => {
    expect(
      resolveAttachmentMediaPolicy({
        sandboxRoot: "  /tmp/workspace  ",
        mediaLocalRoots: ["/tmp/a"],
      }),
    ).toEqual({
      mode: "sandbox",
      sandboxRoot: "/tmp/workspace",
    });
    expect(
      resolveAttachmentMediaPolicy({
        sandboxRoot: "   ",
        mediaLocalRoots: ["/tmp/a"],
      }),
    ).toEqual({
      mode: "host",
      localRoots: ["/tmp/a"],
    });
  });

  maybeIt("normalizes sandbox media lists and dedupes resolved workspace paths", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-list-"));
    try {
      await expect(
        normalizeSandboxMediaList({
          values: [" data:text/plain;base64,QQ== "],
        }),
      ).rejects.toThrow(/data:/i);
      await expect(
        normalizeSandboxMediaList({
          values: [" file:///workspace/assets/photo.png ", "/workspace/assets/photo.png", " "],
          sandboxRoot: ` ${sandboxRoot} `,
        }),
      ).resolves.toEqual([path.join(sandboxRoot, "assets", "photo.png")]);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });
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
    it("returns threadTs when DM target matches currentDmUserId", () => {
      // Regression case: agent in a Slack DM thread sends media via the message tool.
      // buildSlackThreadingToolContext stores currentChannelId as the native "D…" channel ID
      // (so Slack channel actions like react/read/edit/pins can infer the correct target)
      // and currentDmUserId as "user:U…" (so resolveSlackAutoThreadId can match DM sends).
      const result = resolveSlackAutoThreadId({
        to: "user:U0AC3LBA08M",
        toolContext: {
          ...baseContext,
          currentChannelId: "D8SRXRDNF",
          currentDmUserId: "user:U0AC3LBA08M",
        },
      });
      expect(result).toBe("1700000000.111111");
    });

    it("returns undefined when DM target does not match currentDmUserId", () => {
      const result = resolveSlackAutoThreadId({
        to: "user:UDIFFERENT",
        toolContext: {
          ...baseContext,
          currentChannelId: "D8SRXRDNF",
          currentDmUserId: "user:U0AC3LBA08M",
        },
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined when agent is in a DM thread but targets a different channel", () => {
      const result = resolveSlackAutoThreadId({
        to: "channel:CSOMECHANNEL",
        toolContext: {
          ...baseContext,
          currentChannelId: "D8SRXRDNF",
          currentDmUserId: "user:U0AC3LBA08M",
        },
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
          currentChannelId: "D8SRXRDNF",
          currentDmUserId: "user:U0AC3LBA08M",
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
          currentChannelId: "D8SRXRDNF",
          currentDmUserId: "user:U0AC3LBA08M",
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
          currentChannelId: "D8SRXRDNF",
          currentDmUserId: "user:U0AC3LBA08M",
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
        toolContext: { replyToMode: "all", currentDmUserId: "user:U0AC3LBA08M" },
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined when both currentChannelId and currentDmUserId are absent", () => {
      const result = resolveSlackAutoThreadId({
        to: "user:U0AC3LBA08M",
        toolContext: { replyToMode: "all", currentThreadTs: "1700000000.111111" },
      });
      expect(result).toBeUndefined();
    });
  });
});
