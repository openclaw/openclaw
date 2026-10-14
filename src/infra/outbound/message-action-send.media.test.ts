import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Covers message-action media hydration, sandbox path normalization,
// attachments, and channel/plugin media source aliases.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import {
  messageActionRunnerMocks as channelResolutionMocks,
  createWorkspaceMediaTestPlugin,
  resetMessageActionMediaMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const maybeIt = process.platform === "win32" ? it.skip : it;

const workspaceConfig = {
  channels: {
    workspace: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  return requireRecord(arg);
}

async function withSandbox(test: (sandboxDir: string) => Promise<void>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function withTempOpenClawStateDir<T>(test: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "msg-runner-state-" },
    (state) => test(state.stateDir),
  );
}

const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
}) =>
  runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    dryRun: true,
    sandboxRoot: params.sandboxRoot,
    sandboxContainerWorkdir: params.sandboxContainerWorkdir,
  });

const requireRecord = createRequireRecord("record", "expected-non-array-record");

const workspacePlugin = createWorkspaceMediaTestPlugin();

describe("runMessageAction media behavior", () => {
  beforeEach(async () => {
    await resetMessageActionMediaMocks();
  });
  it("copies the normalized idempotency key into send execution context", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "12345678",
        message: "hello",
        idempotencyKey: " run-1:message-tool:send-1:fingerprint ",
      },
    });

    const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
    expect(requireRecord(sendArgs.ctx).idempotencyKey).toBe(
      "run-1:message-tool:send-1:fingerprint",
    );
    expect(requireRecord(sendArgs.ctx).channelPlugin).toBe(workspacePlugin);
    expect(channelResolutionMocks.resolveOutboundChannelPlugin).toHaveBeenCalledTimes(1);
  });

  it("materializes buffer-only send attachments into outbound media paths", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withTempOpenClawStateDir(async () => {
      const result = await runMessageAction({
        cfg: workspaceConfig,
        action: "send",
        params: {
          channel: "workspace",
          target: "12345678",
          buffer: Buffer.from("artifact bytes").toString("base64"),
          filename: "artifact.txt",
          contentType: "text/plain",
        },
      });

      expect(result.kind).toBe("send");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      expect(result.sendResult?.mediaUrl).toBeTypeOf("string");
      await expect(fs.readFile(String(result.sendResult?.mediaUrl), "utf8")).resolves.toBe(
        "artifact bytes",
      );

      const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
      const sendCtx = requireRecord(sendArgs.ctx);
      const sendParams = requireRecord(sendCtx.params);
      expect(sendParams.buffer).toBeUndefined();
      expect(sendArgs.mediaUrl).toBe(result.sendResult?.mediaUrl);
      expect(sendArgs.mediaUrls).toEqual([result.sendResult?.mediaUrl]);
    });
  });

  it("rejects oversized buffer-only send attachments before channel dispatch", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withTempOpenClawStateDir(async () => {
      await expect(
        runMessageAction({
          cfg: workspaceConfig,
          action: "send",
          params: {
            channel: "workspace",
            target: "12345678",
            message: "too large",
            buffer: Buffer.alloc(MEDIA_MAX_BYTES + 1, 1).toString("base64"),
            contentType: "application/octet-stream",
          },
        }),
      ).rejects.toThrow(/too large|limit/i);

      expect(channelResolutionMocks.executeSendAction).not.toHaveBeenCalled();
    });
  });

  it("previews dry-run buffer-only sends without writing outbound media files", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withTempOpenClawStateDir(async (stateDir) => {
      const result = await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "12345678",
          buffer: Buffer.from("preview bytes").toString("base64"),
          filename: "preview.txt",
          contentType: "text/plain",
        },
      });

      expect(result.kind).toBe("send");
      const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
      const sendCtx = requireRecord(sendArgs.ctx);
      const sendParams = requireRecord(sendCtx.params);
      expect(sendParams.buffer).toBeUndefined();
      expect(sendArgs.mediaUrl).toBe("buffer://message-send/attachment");
      expect(sendArgs.mediaUrls).toEqual(["buffer://message-send/attachment"]);
      await expect(fs.readdir(path.join(stateDir, "media", "outbound"))).rejects.toThrow();
    });
  });

  it("treats top-level image param as a send media source", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withSandbox(async (sandboxDir) => {
      const result = await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "12345678",
          message: "1/7",
          image: "/workspace/photo.jpg",
        },
        sandboxRoot: sandboxDir,
      });

      expect(result.kind).toBe("send");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "photo.jpg"));
      expect(result.sendResult?.mediaUrls).toEqual([path.join(sandboxDir, "photo.jpg")]);
    });
  });

  it("sends structured mediaUrls arrays", async () => {
    setTestPlugin(workspacePlugin, "workspace");

    await withSandbox(async (sandboxDir) => {
      const result = await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "12345678",
          mediaUrls: ["./one.png", "/workspace/two.png"],
        },
        sandboxRoot: sandboxDir,
      });

      expect(result.kind).toBe("send");
      if (result.kind !== "send") {
        throw new Error("expected send result");
      }
      expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "one.png"));
      expect(result.sendResult?.mediaUrls).toEqual([
        path.join(sandboxDir, "one.png"),
        path.join(sandboxDir, "two.png"),
      ]);
      const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
      const sendCtx = requireRecord(sendArgs.ctx);
      const sendParams = requireRecord(sendCtx.params);
      const sendMediaAccess = requireRecord(sendCtx.mediaAccess);
      expect(sendMediaAccess.localRoots).toEqual(expect.arrayContaining([sandboxDir]));
      expect(sendParams.mediaUrls).toEqual([
        path.join(sandboxDir, "one.png"),
        path.join(sandboxDir, "two.png"),
      ]);
    });
  });

  maybeIt.each([{ name: "OpenShell", containerWorkdir: "/sandbox" }])(
    "dedupes resolved $name media while retaining first-entry metadata",
    async ({ containerWorkdir }) => {
      setTestPlugin(workspacePlugin, "workspace");

      await withSandbox(async (sandboxDir) => {
        await runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "12345678",
            message: "attachments ready",
            media: `file://${containerWorkdir}/assets/photo.png`,
            filename: "first.png",
            contentType: "image/png",
            mediaUrls: [
              ` file://${containerWorkdir}/assets/photo.png `,
              `${containerWorkdir}/assets/photo.png`,
              "buffer://message-send/attachment",
              " ",
            ],
            attachments: [
              {
                path: `${containerWorkdir}/assets/photo.png`,
                name: "later.bin",
                mimeType: "application/octet-stream",
                type: "file",
              },
              {
                path: `${containerWorkdir}/last.txt`,
                name: "last.txt",
                mimeType: "text/plain",
                type: "file",
              },
            ],
          },
          sandboxRoot: ` ${sandboxDir} `,
          sandboxContainerWorkdir: containerWorkdir,
        });

        expect(channelResolutionMocks.executeSendAction).toHaveBeenCalledTimes(1);
        const sendArgs = firstMockArg(
          channelResolutionMocks.executeSendAction,
          "executeSendAction",
        );
        const mediaUrls = [
          path.join(sandboxDir, "assets", "photo.png"),
          "buffer://message-send/attachment",
          path.join(sandboxDir, "last.txt"),
        ];
        expect(sendArgs.mediaUrls).toEqual(mediaUrls);
        expect(requireRecord(sendArgs.payload).mediaUrls).toEqual(mediaUrls);
        expect(requireRecord(sendArgs.payload).attachments).toEqual([
          { path: mediaUrls[0], type: "file", name: "first.png", mimeType: "image/png" },
          { path: mediaUrls[1] },
          { path: mediaUrls[2], type: "file", name: "last.txt", mimeType: "text/plain" },
        ]);
      });
    },
  );

  it.each([{ name: "blank", sandboxRoot: "   " }])(
    "preserves ordered remote media when the sandbox root is $name",
    async ({ sandboxRoot }) => {
      setTestPlugin(workspacePlugin, "workspace");
      const mediaUrls = [
        "https://example.com/first.png?sig=1",
        "http://example.com/second.png",
        "mxc://matrix.org/opaque-media",
        "buffer://message-send/attachment",
      ];

      await runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "12345678",
          message: "attachments ready",
          mediaUrls: [` ${mediaUrls[0]} `, mediaUrls[0], ...mediaUrls.slice(1), " "],
        },
        sandboxRoot,
      });

      expect(channelResolutionMocks.executeSendAction).toHaveBeenCalledTimes(1);
      const sendArgs = firstMockArg(channelResolutionMocks.executeSendAction, "executeSendAction");
      expect(sendArgs.mediaUrls).toEqual(mediaUrls);
      expect(requireRecord(sendArgs.payload).mediaUrls).toEqual(mediaUrls);
      expect(requireRecord(sendArgs.payload)).not.toHaveProperty("attachments");
    },
  );

  it.each([false, true])(
    "rejects a later invalid media hint before any dispatch (sandbox=%s)",
    async (sandboxed) => {
      setTestPlugin(workspacePlugin, "workspace");
      await withSandbox(async (sandboxDir) => {
        await expect(
          runDrySend({
            cfg: workspaceConfig,
            actionParams: {
              channel: "workspace",
              target: "12345678",
              message: "must not send partially",
              mediaUrls: [
                "https://example.com/first.png",
                " data:text/plain;base64,QQ== ",
                "https://example.com/last.png",
              ],
            },
            sandboxRoot: sandboxed ? sandboxDir : undefined,
          }),
        ).rejects.toThrow("data: URLs are not supported for media. Use buffer instead.");
        expect(channelResolutionMocks.executeSendAction).not.toHaveBeenCalled();
        expect(channelResolutionMocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
      });
    },
  );
});

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5m8gAAAABJRU5ErkJggg==",
  "base64",
);

function requireActionPayload(
  result: Awaited<ReturnType<typeof runMessageAction>>,
): Record<string, unknown> {
  expect(result.kind).toBe("action");
  if (result.kind !== "action") {
    throw new Error("expected action result");
  }
  return requireRecord(result.payload);
}

describe("runMessageAction media access", () => {
  beforeEach(async () => {
    await resetMessageActionMediaMocks();
  });
  describe("plugin-owned media-source discovery routing", () => {
    const profilePlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "profile-demo",
        label: "Profile Demo",
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          isConfigured: () => true,
        },
      }),
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "profile-demo-target" }),
        sendText: async () => ({ channel: "profile-demo", messageId: "msg-test" }),
        sendMedia: async () => ({ channel: "profile-demo", messageId: "msg-test" }),
      },
      actions: {
        describeMessageTool: () => ({
          actions: ["send", "set-profile"],
          mediaSourceParams: {
            "set-profile": ["avatarPath", "avatarUrl"],
          },
          schema: {
            properties: {
              avatarPath: Type.Optional(Type.String({ description: "Local avatar path" })),
              avatarUrl: Type.Optional(Type.String({ description: "Remote avatar URL" })),
              displayName: Type.Optional(Type.String()),
            },
          },
        }),
        supportsAction: ({ action }) => action === "set-profile" || action === "send",
        handleAction: async ({ params, mediaLocalRoots }) =>
          jsonResult({
            ok: true,
            avatarPath: params.avatarPath,
            avatarUrl: params.avatarUrl,
            mediaLocalRoots,
          }),
      },
    };

    beforeEach(() => {
      setTestPlugin(profilePlugin, "profile-demo");
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
    });

    it("rewrites plugin-owned sandbox media params and preserves mxc URLs", async () => {
      await withSandbox(async (sandboxDir) => {
        const result = await runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "set-profile",
          params: {
            channel: "profile-demo",
            avatarPath: "/workspace/avatars/profile.png",
            avatarUrl: "mxc://matrix.org/abc123def456",
          },
          sandboxRoot: sandboxDir,
        });

        const payload = requireActionPayload(result);
        expect(payload.ok).toBe(true);
        expect(payload.avatarPath).toBe(path.join(sandboxDir, "avatars", "profile.png"));
        expect(payload.avatarUrl).toBe("mxc://matrix.org/abc123def456");
      });
    });

    it("routes plugin-owned host media hints into local-root expansion", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-profile-media-"));
      try {
        const avatarPath = path.join(tempDir, "profile.png");
        await fs.writeFile(avatarPath, onePixelPng);

        const result = await runMessageAction({
          cfg: {
            tools: { fs: { workspaceOnly: false } },
          } as OpenClawConfig,
          action: "set-profile",
          params: {
            channel: "profile-demo",
            avatarPath,
          },
        });

        expect(result.kind).toBe("action");
        const mediaLocalRoots = requireActionPayload(result).mediaLocalRoots;
        expect(Array.isArray(mediaLocalRoots)).toBe(true);
        expect(mediaLocalRoots).toContain(tempDir);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not apply set-profile media params to send actions", async () => {
      await withSandbox(async (sandboxDir) => {
        const avatarUrl = "data:text/plain;base64,SGVsbG8=";
        const result = await runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          dryRun: true,
          params: {
            channel: "profile-demo",
            target: "@profile-demo",
            message: "hi",
            avatarUrl,
          },
          sandboxRoot: sandboxDir,
        });

        expect(result.kind).toBe("send");
        if (result.kind !== "send") {
          throw new Error("expected send result");
        }
        if (!result.sendResult) {
          throw new Error("Expected send result payload");
        }
        expect(result.sendResult.channel).toBe("profile-demo");
      });
    });
  });

  describe("sandboxed media validation", () => {
    beforeEach(() => {
      setTestPlugin(workspacePlugin, "workspace");
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
    });

    it.each([
      {
        name: "media absolute path",
        mediaField: "media" as const,
        media: "/etc/passwd",
      },
      {
        name: "mediaUrl absolute path",
        mediaField: "mediaUrl" as const,
        media: "/etc/passwd",
      },
      {
        name: "mediaUrl file URL",
        mediaField: "mediaUrl" as const,
        media: "file:///etc/passwd",
      },
      {
        name: "fileUrl file URL",
        mediaField: "fileUrl" as const,
        media: "file:///etc/passwd",
      },
    ])("rejects out-of-sandbox media reference: $name", async ({ mediaField, media }) => {
      await withSandbox(async (sandboxDir) => {
        await expect(
          runDrySend({
            cfg: workspaceConfig,
            actionParams: {
              channel: "workspace",
              target: "12345678",
              [mediaField]: media,
              message: "",
            },
            sandboxRoot: sandboxDir,
          }),
        ).rejects.toThrow(/sandbox/i);
      });
    });

    it("rejects data URLs in media params", async () => {
      await expect(
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "12345678",
            media: "data:image/png;base64,abcd",
            message: "",
          },
        }),
      ).rejects.toThrow(/data:/i);
    });

    it("prefers media over mediaUrl when both aliases are present", async () => {
      await withSandbox(async (sandboxDir) => {
        const result = await runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "12345678",
            media: "./data/primary.txt",
            mediaUrl: "./data/secondary.txt",
            message: "",
          },
          sandboxRoot: sandboxDir,
        });

        expect(result.kind).toBe("send");
        if (result.kind !== "send") {
          throw new Error("expected send result");
        }
        expect(result.sendResult?.mediaUrl).toBe(path.join(sandboxDir, "data", "primary.txt"));
      });
    });

    it.each([
      {
        name: "mediaUrl",
        mediaField: "mediaUrl" as const,
      },
      {
        name: "fileUrl",
        mediaField: "fileUrl" as const,
      },
    ])(
      "keeps remote HTTP $name aliases unchanged under sandbox validation",
      async ({ mediaField }) => {
        await withSandbox(async (sandboxDir) => {
          const remoteUrl = "https://example.com/files/report.pdf?sig=1";
          const result = await runDrySend({
            cfg: workspaceConfig,
            actionParams: {
              channel: "workspace",
              target: "12345678",
              [mediaField]: remoteUrl,
              message: "",
            },
            sandboxRoot: sandboxDir,
          });

          expect(result.kind).toBe("send");
          if (result.kind !== "send") {
            throw new Error("expected send result");
          }
          expect(result.sendResult?.mediaUrl).toBe(remoteUrl);
        });
      },
    );

    it("allows media paths under preferred OpenClaw tmp root", async () => {
      const tmpRoot = resolvePreferredOpenClawTmpDir();
      await fs.mkdir(tmpRoot, { recursive: true });
      const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
      try {
        const tmpFile = path.join(tmpRoot, "test-media-image.png");
        const result = await runMessageAction({
          cfg: workspaceConfig,
          action: "send",
          params: {
            channel: "workspace",
            target: "12345678",
            media: tmpFile,
            message: "",
          },
          sandboxRoot: sandboxDir,
          dryRun: true,
        });

        expect(result.kind).toBe("send");
        if (result.kind !== "send") {
          throw new Error("expected send result");
        }
        expect(result.sendResult?.mediaUrl).toBe(path.resolve(tmpFile));
        const hostTmpOutsideOpenClaw = path.join(os.tmpdir(), "outside-openclaw", "test-media.png");
        await expect(
          runMessageAction({
            cfg: workspaceConfig,
            action: "send",
            params: {
              channel: "workspace",
              target: "12345678",
              media: hostTmpOutsideOpenClaw,
              message: "",
            },
            sandboxRoot: sandboxDir,
            dryRun: true,
          }),
        ).rejects.toThrow(/sandbox/i);
      } finally {
        await fs.rm(sandboxDir, { recursive: true, force: true });
      }
    });
  });
});
