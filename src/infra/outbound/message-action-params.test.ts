// Covers message-action media param collection, sandbox normalization, base64
// hydration, structured attachments, JSON params, and plugin alias gating.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const { resolveChannelMessageToolMediaSourceParamKeysMock } = vi.hoisted(() => ({
  resolveChannelMessageToolMediaSourceParamKeysMock: vi.fn(() => ["avatarPath", "avatarUrl"]),
}));

vi.mock("../../channels/plugins/message-action-discovery.js", () => ({
  resolveChannelMessageToolMediaSourceParamKeys: resolveChannelMessageToolMediaSourceParamKeysMock,
}));

import {
  collectActionMediaSourceHints,
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaParams,
  resolveExtraActionMediaSourceParamKeys,
  resolveAttachmentMediaPolicy,
} from "./message-action-params.js";

const cfg = {} as OpenClawConfig;
const maybeIt = process.platform === "win32" ? it.skip : it;
const matrixMediaSourceParamKeys = ["avatarPath", "avatarUrl"] as const;

async function withTempOpenClawStateDir<T>(test: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "msg-params-state-" },
    (state) => test(state.stateDir),
  );
}

describe("message action media helpers", () => {
  beforeEach(() => {
    resolveChannelMessageToolMediaSourceParamKeysMock.mockClear();
  });

  it("skips plugin media discovery when args only use standard action params", () => {
    expect(
      resolveExtraActionMediaSourceParamKeys({
        cfg,
        action: "send",
        channel: "workspace",
        args: {
          channel: "workspace",
          target: "#C12345678",
          message: "hi",
          buffer: Buffer.from("artifact").toString("base64"),
          filename: "artifact.txt",
          contentType: "text/plain",
          media: "https://example.com/photo.png",
          media_urls: ["https://example.com/extra.png"],
        },
      }),
    ).toStrictEqual([]);
    expect(resolveChannelMessageToolMediaSourceParamKeysMock).not.toHaveBeenCalled();
  });

  it("prefers sandbox media policy when sandbox roots are non-blank", () => {
    const mediaReadFile = async () => Buffer.from("sandbox");
    expect(
      resolveAttachmentMediaPolicy({
        sandboxRoot: "  /tmp/workspace  ",
        mediaAccess: { readFile: mediaReadFile },
        mediaLocalRoots: ["/tmp/a"],
      }),
    ).toEqual({
      mode: "sandbox",
      sandboxRoot: "/tmp/workspace",
    });
    expect(
      resolveAttachmentMediaPolicy({
        sandboxRoot: "/tmp/workspace",
        sandboxContainerWorkdir: "/sandbox",
        mediaAccess: { readFile: mediaReadFile },
        mediaReadFile,
      }),
    ).toEqual({
      mode: "sandbox",
      sandboxRoot: "/tmp/workspace",
      containerWorkdir: "/sandbox",
      mediaReadFile,
    });
    expect(
      resolveAttachmentMediaPolicy({
        sandboxRoot: "   ",
        mediaLocalRoots: ["/tmp/a"],
      }),
    ).toEqual({
      mode: "host",
      mediaAccess: {
        localRoots: ["/tmp/a"],
      },
      mediaLocalRoots: ["/tmp/a"],
    });
  });

  it("preserves explicit any local roots for host read opt-ins", () => {
    const mediaReadFile = async () => Buffer.from("x");
    expect(
      resolveAttachmentMediaPolicy({
        mediaLocalRoots: "any",
        mediaReadFile,
      }),
    ).toEqual({
      mode: "host",
      mediaAccess: {
        readFile: mediaReadFile,
      },
      mediaLocalRoots: "any",
      mediaReadFile,
    });
  });

  maybeIt.each([
    "mediaUrl",
    "media_url",
    "path",
    "filePath",
    "file_path",
    "fileUrl",
    "file_url",
    "url",
  ])("rejects an out-of-sandbox %s hidden behind valid attachment media", async (shadowKey) => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-shadow-sandbox-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-shadow-host-"));
    try {
      await expect(
        normalizeSandboxMediaParams({
          args: {
            attachments: [
              {
                media: "/workspace/allowed.png",
                [shadowKey]: path.join(outsideRoot, "restricted.png"),
              },
            ],
          },
          mediaPolicy: {
            mode: "sandbox",
            sandboxRoot,
          },
          structuredAttachments: "all",
        }),
      ).rejects.toThrow(/escapes sandbox root/i);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  maybeIt("normalizes every allowed source in one structured attachment", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-multi-source-"));
    try {
      const attachment: Record<string, unknown> = {
        media: "/workspace/allowed.png",
        file_path: "/workspace/allowed-file.png",
      };

      await normalizeSandboxMediaParams({
        args: { attachments: [attachment] },
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot,
        },
        structuredAttachments: "all",
      });

      expect(attachment).toEqual({
        media: path.join(sandboxRoot, "allowed.png"),
        file_path: path.join(sandboxRoot, "allowed-file.png"),
      });
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("collects host media source hints from the shared media-source key set", () => {
    expect(
      collectActionMediaSourceHints(
        {
          media: " /workspace/uploads/photo.png ",
          filePath: "",
          image: "file:///workspace/assets/event-cover.png",
          media_urls: [" /workspace/extra/diagram.png ", ""],
          avatarPath: "/workspace/avatars/profile.png",
          avatar_url: "mxc://matrix.org/abc123def456",
          ignored: "/workspace/not-included.png",
        },
        matrixMediaSourceParamKeys,
      ),
    ).toEqual([
      " /workspace/uploads/photo.png ",
      "file:///workspace/assets/event-cover.png",
      "/workspace/avatars/profile.png",
      "mxc://matrix.org/abc123def456",
      "/workspace/extra/diagram.png",
    ]);
  });

  it("does not collect ignored structured attachments when top-level media wins", () => {
    expect(
      collectActionMediaSourceHints({
        media: "https://example.com/top-level.png",
        attachments: [
          {
            path: "/workspace/uploads/ignored.png",
            mimeType: "image/png",
            name: "ignored.png",
          },
        ],
      }),
    ).toEqual(["https://example.com/top-level.png"]);
  });

  it("does not collect ignored structured attachments when plugin media params win", () => {
    expect(
      collectActionMediaSourceHints(
        {
          avatarPath: "/workspace/avatars/profile.png",
          attachments: [
            {
              path: "/workspace/uploads/ignored.png",
              mimeType: "image/png",
              name: "ignored.png",
            },
          ],
        },
        matrixMediaSourceParamKeys,
      ),
    ).toEqual(["/workspace/avatars/profile.png"]);
  });

  maybeIt("normalizes extension snake_case avatar_path and avatar_url aliases", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-avatar-snake-"));
    try {
      const args: Record<string, unknown> = {
        avatar_path: "/workspace/avatars/profile.png",
        avatar_url: "file:///workspace/avatars/remote-avatar.jpg",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot,
        },
        extraParamKeys: matrixMediaSourceParamKeys,
      });

      expect(args.avatar_path).toBe(path.join(sandboxRoot, "avatars", "profile.png"));
      expect(args.avatar_url).toBe(path.join(sandboxRoot, "avatars", "remote-avatar.jpg"));
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt("prefers canonical extension media params over invalid snake_case aliases", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-avatar-canonical-"));
    try {
      const args: Record<string, unknown> = {
        avatarUrl: "https://example.com/avatars/profile.png",
        avatar_url: "data:text/plain;base64,QQ==",
        avatarPath: "/workspace/avatars/profile.png",
        avatar_path: "data:text/plain;base64,QQ==",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot,
        },
        extraParamKeys: matrixMediaSourceParamKeys,
      });

      expect(args.avatarUrl).toBe("https://example.com/avatars/profile.png");
      expect(args.avatarPath).toBe(path.join(sandboxRoot, "avatars", "profile.png"));
      expect(args.avatar_url).toBe("data:text/plain;base64,QQ==");
      expect(args.avatar_path).toBe("data:text/plain;base64,QQ==");
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("uses mediaUrl and fileUrl aliases when inferring attachment filenames", async () => {
    const mediaArgs: Record<string, unknown> = {
      mediaUrl: "https://example.com/pic.png",
    };
    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "workspace",
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
      channel: "workspace",
      args: fileArgs,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });
    expect(fileArgs.filename).toBe("report.pdf");
  });

  it("uses only the leaf filename from Windows-style attachment hints", async () => {
    const args: Record<string, unknown> = {
      fileUrl: String.raw`C:\Users\Ada\Downloads\report.pdf`,
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "workspace",
      args,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.filename).toBe("report.pdf");
  });

  it("falls back to extension-based attachment names for remote-host file URLs", async () => {
    const args: Record<string, unknown> = {
      media: "file://attacker/share/photo.png",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "workspace",
      args,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.filename).toBe("attachment");
  });

  it("does not hydrate ignored structured attachments when plugin media params win", async () => {
    const args: Record<string, unknown> = {
      avatarPath: "/workspace/avatars/profile.png",
      attachments: [
        {
          url: "https://example.com/ignored.png",
          mimeType: "image/png",
          name: "ignored.png",
        },
      ],
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "imessage",
      args,
      action: "reply",
      dryRun: true,
      mediaPolicy: { mode: "host" },
      extraParamKeys: matrixMediaSourceParamKeys,
    });

    expect(args.filename).toBe("attachment");
    expect(args.contentType).toBeUndefined();
  });

  it("rejects oversized buffer-only send params before base64 decoding", async () => {
    await withTempOpenClawStateDir(async () => {
      const fromSpy = vi.spyOn(Buffer, "from");
      const args: Record<string, unknown> = {
        buffer: Buffer.alloc(MEDIA_MAX_BYTES + 1, 1).toString("base64"),
        contentType: "application/octet-stream",
      };

      try {
        await expect(
          hydrateAttachmentParamsForAction({
            cfg,
            channel: "workspace",
            args,
            action: "send",
            mediaPolicy: { mode: "host" },
          }),
        ).rejects.toThrow(/too large|limit/i);

        const base64Calls = (fromSpy.mock.calls as ReadonlyArray<readonly unknown[]>).filter(
          (call) => call[1] === "base64",
        );
        expect(base64Calls).toHaveLength(0);
        expect(args.media).toBeUndefined();
        expect(args.mediaUrl).toBeUndefined();
      } finally {
        fromSpy.mockRestore();
      }
    });
  });

  it("rejects invalid buffer-only send base64 without staging media", async () => {
    await withTempOpenClawStateDir(async () => {
      const args: Record<string, unknown> = {
        buffer: "not-base64!",
        contentType: "text/plain",
      };

      await expect(
        hydrateAttachmentParamsForAction({
          cfg,
          channel: "workspace",
          args,
          action: "send",
          mediaPolicy: { mode: "host" },
        }),
      ).rejects.toThrow(/invalid base64/i);

      expect(args.media).toBeUndefined();
      expect(args.mediaUrl).toBeUndefined();
    });
  });

  it("skips send buffer materialization when an explicit media source is present", async () => {
    await withTempOpenClawStateDir(async (stateDir) => {
      const args: Record<string, unknown> = {
        buffer: Buffer.from("ignored").toString("base64"),
        mediaUrl: "https://example.com/pic.png",
      };

      await hydrateAttachmentParamsForAction({
        cfg,
        channel: "workspace",
        args,
        action: "send",
        mediaPolicy: { mode: "host" },
      });

      expect(args.mediaUrl).toBe("https://example.com/pic.png");
      expect(args.media).toBeUndefined();
      expect(args.buffer).toBeUndefined();
      await expect(fs.readdir(path.join(stateDir, "media", "outbound"))).rejects.toThrow();
    });
  });

  it.each(
    ["dry-run", "preserve-buffer"].flatMap((mode) => [
      {
        mode,
        buffer: "data:application/octet-stream;base64,SGVsbG8=",
        name: "data URL",
        expectedError: undefined,
      },
      {
        mode,
        buffer: "SGVsbG8h",
        name: "one byte over the limit",
        expectedError: "Media too large: 6 bytes (limit: 5 bytes)",
      },
      {
        mode,
        buffer: "!!!!!!!!",
        name: "oversized malformed base64",
        expectedError: "Media too large: 6 bytes (limit: 5 bytes)",
      },
      {
        mode,
        buffer: " \t\r\n",
        name: "whitespace-only base64",
        expectedError: "message.send buffer has invalid base64 data",
      },
    ]),
  )("validates $mode $name without staging", async ({ mode, buffer, expectedError }) => {
    await withTempOpenClawStateDir(async (stateDir) => {
      const args: Record<string, unknown> = {
        buffer,
        filename: "preview.txt",
        mimeType: "text/plain",
      };

      const hydration = hydrateAttachmentParamsForAction({
        cfg: { agents: { defaults: { mediaMaxMb: 5 / (1024 * 1024) } } },
        channel: "imessage",
        args,
        action: "send",
        dryRun: mode === "dry-run",
        preserveSendBuffer: mode === "preserve-buffer",
        mediaPolicy: { mode: "host" },
      });

      if (expectedError) {
        await expect(hydration).rejects.toThrow(expectedError);
        expect(args).toEqual({ buffer, filename: "preview.txt", mimeType: "text/plain" });
      } else {
        await hydration;
        expect(args.media).toBe("buffer://message-send/attachment");
        expect(args.mediaUrl).toBe("buffer://message-send/attachment");
        expect(args.mediaUrls).toEqual(["buffer://message-send/attachment"]);
        expect(args.buffer).toBe(mode === "preserve-buffer" ? buffer : undefined);
        expect(args.contentType).toBe("text/plain");
        expect(args.filename).toBe("preview.txt");
      }
      await expect(fs.readdir(path.join(stateDir, "media", "outbound"))).rejects.toThrow();
    });
  });
});

describe("message action send buffer honors the non-positive channel cap rule", () => {
  it.each([
    { mediaMaxMb: 0, label: "zero" },
    { mediaMaxMb: -5, label: "negative" },
  ])(
    "attaches a small buffer instead of a 0-byte cap for a $label channels.line.mediaMaxMb",
    async ({ mediaMaxMb }) => {
      await withTempOpenClawStateDir(async () => {
        const args: Record<string, unknown> = {
          buffer: "SGVsbG8=",
          filename: "preview.txt",
          mimeType: "text/plain",
        };

        await hydrateAttachmentParamsForAction({
          cfg: { channels: { line: { mediaMaxMb } } },
          channel: "line",
          args,
          action: "send",
          dryRun: true,
          mediaPolicy: { mode: "host" },
        });

        expect(args.media).toBe("buffer://message-send/attachment");
      });
    },
  );

  it("keeps capping send buffers at a positive channels.line.mediaMaxMb", async () => {
    await withTempOpenClawStateDir(async () => {
      const args: Record<string, unknown> = {
        buffer: "SGVsbG8h",
        filename: "preview.txt",
        mimeType: "text/plain",
      };

      await expect(
        hydrateAttachmentParamsForAction({
          cfg: { channels: { line: { mediaMaxMb: 5 / (1024 * 1024) } } },
          channel: "line",
          args,
          action: "send",
          dryRun: true,
          mediaPolicy: { mode: "host" },
        }),
      ).rejects.toThrow("Media too large: 6 bytes (limit: 5 bytes)");
    });
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
          channel: "workspace",
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
