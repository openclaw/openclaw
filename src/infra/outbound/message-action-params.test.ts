import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSlackAutoThreadId } from "../../plugin-sdk/slack.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaList,
  normalizeSandboxMediaParams,
  resolveAttachmentMediaPolicy,
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

function resolveTelegramAutoThreadIdForTest(params: {
  to: string;
  toolContext?: { currentThreadTs?: string; currentChannelId?: string };
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentThreadTs || !context.currentChannelId) {
    return undefined;
  }
  const normalizeChatId = (raw: string) => {
    let trimmed = raw.trim();
    let strippedTelegramPrefix = false;
    while (true) {
      if (/^(telegram|tg):/i.test(trimmed)) {
        strippedTelegramPrefix = true;
        trimmed = trimmed.replace(/^(telegram|tg):/i, "").trim();
        continue;
      }
      if (strippedTelegramPrefix && /^group:/i.test(trimmed)) {
        trimmed = trimmed.replace(/^group:/i, "").trim();
        continue;
      }
      break;
    }
    const groupTopic = /^group:([^:]+):topic:\d+$/i.exec(trimmed);
    if (groupTopic) {
      return groupTopic[1].toLowerCase();
    }
    const topic = /^([^:]+):topic:\d+$/i.exec(trimmed);
    if (topic) {
      return topic[1].toLowerCase();
    }
    const colonPair = /^([^:]+):\d+$/i.exec(trimmed);
    if (colonPair && colonPair[1].startsWith("-")) {
      return colonPair[1].toLowerCase();
    }
    return trimmed.toLowerCase();
  };
  return normalizeChatId(params.to) === normalizeChatId(context.currentChannelId)
    ? context.currentThreadTs
    : undefined;
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
      resolveTelegramAutoThreadIdForTest({
        to: "telegram:group:-100123:topic:77",
        toolContext: createToolContext({
          currentChannelId: "tg:group:-100123",
        }),
      }),
    ).toBe("thread-1");
    expect(
      resolveTelegramAutoThreadIdForTest({
        to: "-100999:77",
        toolContext: createToolContext({
          currentChannelId: "-100123",
        }),
      }),
    ).toBeUndefined();
    expect(
      resolveTelegramAutoThreadIdForTest({
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

  maybeIt("normalizes mediaUrl and fileUrl sandbox media params", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-alias-"));
    try {
      const args: Record<string, unknown> = {
        mediaUrl: " file:///workspace/assets/photo.png ",
        fileUrl: "/workspace/docs/report.pdf",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot: ` ${sandboxRoot} `,
        },
      });

      expect(args).toMatchObject({
        mediaUrl: path.join(sandboxRoot, "assets", "photo.png"),
        fileUrl: path.join(sandboxRoot, "docs", "report.pdf"),
      });
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt(
    "keeps remote HTTP mediaUrl and fileUrl aliases unchanged under sandbox normalization",
    async () => {
      const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-remote-alias-"));
      try {
        const args: Record<string, unknown> = {
          mediaUrl: "https://example.com/assets/photo.png?sig=1",
          fileUrl: "https://example.com/docs/report.pdf?sig=2",
        };

        await normalizeSandboxMediaParams({
          args,
          mediaPolicy: {
            mode: "sandbox",
            sandboxRoot,
          },
        });

        expect(args).toMatchObject({
          mediaUrl: "https://example.com/assets/photo.png?sig=1",
          fileUrl: "https://example.com/docs/report.pdf?sig=2",
        });
      } finally {
        await fs.rm(sandboxRoot, { recursive: true, force: true });
      }
    },
  );

  it("uses mediaUrl and fileUrl aliases when inferring attachment filenames", async () => {
    const mediaArgs: Record<string, unknown> = {
      mediaUrl: "https://example.com/pic.png",
    };
    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "slack",
      args: mediaArgs,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });
    expect(mediaArgs.filename).toBe("pic.png");

    const fileArgs: Record<string, unknown> = {
      fileUrl: "https://example.com/docs/report.pdf",
    };
    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "slack",
      args: fileArgs,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });
    expect(fileArgs.filename).toBe("report.pdf");
  });

  it("falls back to extension-based attachment names for remote-host file URLs", async () => {
    const args: Record<string, unknown> = {
      media: "file://attacker/share/photo.png",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "slack",
      args,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.filename).toBe("attachment");
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
