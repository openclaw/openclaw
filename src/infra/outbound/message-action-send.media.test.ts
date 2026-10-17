import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import {
  messageActionRunnerMocks as mocks,
  createWorkspaceMediaTestPlugin,
  resetMessageActionMediaMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const maybeIt = process.platform === "win32" ? it.skip : it;

const workspaceConfig = {
  channels: { workspace: { botToken: "xoxb-test", appToken: "xapp-test" } },
} as OpenClawConfig;

async function withSandbox(test: (sandboxDir: string) => Promise<void>, prefix = "msg-sandbox-") {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

const runDrySend = (
  params: Record<string, unknown>,
  sandboxRoot?: string,
  sandboxContainerWorkdir?: string,
) =>
  runMessageAction({
    cfg: workspaceConfig,
    action: "send",
    dryRun: true,
    params: { channel: "workspace", target: "12345678", ...params },
    sandboxRoot,
    sandboxContainerWorkdir,
  });

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function sendResult(result: Awaited<ReturnType<typeof runMessageAction>>) {
  expect(result.kind).toBe("send");
  if (result.kind !== "send" || !result.sendResult) {
    throw new Error("expected send result");
  }
  return result.sendResult;
}
const sendArgs = () =>
  mockFirstRecordArg(mocks.executeSendAction, "executeSendAction", "Expected a non-array record");

const workspacePlugin = createWorkspaceMediaTestPlugin();

describe("runMessageAction media behavior", () => {
  beforeEach(async () => {
    await resetMessageActionMediaMocks();
    setTestPlugin(workspacePlugin, "workspace");
  });
  it("materializes buffer-only send attachments into outbound media paths", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "msg-runner-state-" }, async () => {
      const result = await runMessageAction({
        cfg: workspaceConfig,
        action: "send",
        params: {
          channel: "workspace",
          target: "12345678",
          buffer: Buffer.from("artifact bytes").toString("base64"),
          filename: "artifact.txt",
          contentType: "text/plain",
          idempotencyKey: " run-1:message-tool:send-1:fingerprint ",
        },
      });

      const sent = sendResult(result);
      expect(sent?.mediaUrl).toBeTypeOf("string");
      await expect(fs.readFile(String(sent?.mediaUrl), "utf8")).resolves.toBe("artifact bytes");

      const args = sendArgs();
      const sendCtx = requireRecord(args.ctx);
      expect(sendCtx.idempotencyKey).toBe("run-1:message-tool:send-1:fingerprint");
      expect(sendCtx.channelPlugin).toBe(workspacePlugin);
      expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledTimes(1);
      const sendParams = requireRecord(sendCtx.params);
      expect(sendParams.buffer).toBeUndefined();
      expect(args.mediaUrl).toBe(sent?.mediaUrl);
      expect(args.mediaUrls).toEqual([sent?.mediaUrl]);
    });
  });

  it("treats top-level image param as a send media source", async () => {
    await withSandbox(async (sandboxDir) => {
      const result = await runDrySend(
        {
          message: "1/7",
          image: "/workspace/photo.jpg",
        },
        sandboxDir,
      );

      const sent = sendResult(result);
      const mediaUrl = path.join(sandboxDir, "photo.jpg");
      expect(sent).toMatchObject({ mediaUrl, mediaUrls: [mediaUrl] });
    });
  });

  it("sends structured mediaUrls arrays", async () => {
    await withSandbox(async (sandboxDir) => {
      const result = await runDrySend(
        {
          mediaUrls: ["./one.png", "/workspace/two.png"],
        },
        sandboxDir,
      );

      const mediaUrls = [path.join(sandboxDir, "one.png"), path.join(sandboxDir, "two.png")];
      expect(sendResult(result)).toMatchObject({ mediaUrl: mediaUrls[0], mediaUrls });
      const args = sendArgs();
      const sendCtx = requireRecord(args.ctx);
      const sendParams = requireRecord(sendCtx.params);
      const sendMediaAccess = requireRecord(sendCtx.mediaAccess);
      expect(sendMediaAccess.localRoots).toEqual(expect.arrayContaining([sandboxDir]));
      expect(sendParams.mediaUrls).toEqual(mediaUrls);
    });
  });

  maybeIt.each([{ name: "OpenShell", containerWorkdir: "/sandbox" }])(
    "dedupes resolved $name media while retaining first-entry metadata",
    async ({ containerWorkdir }) => {
      await withSandbox(async (sandboxDir) => {
        await runDrySend(
          {
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
          ` ${sandboxDir} `,
          containerWorkdir,
        );

        expect(mocks.executeSendAction).toHaveBeenCalledTimes(1);
        const args = sendArgs();
        const mediaUrls = [
          path.join(sandboxDir, "assets", "photo.png"),
          "buffer://message-send/attachment",
          path.join(sandboxDir, "last.txt"),
        ];
        expect(args.mediaUrls).toEqual(mediaUrls);
        expect(requireRecord(args.payload).mediaUrls).toEqual(mediaUrls);
        expect(requireRecord(args.payload).attachments).toEqual([
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
      const mediaUrls = [
        "https://example.com/first.png?sig=1",
        "http://example.com/second.png",
        "mxc://matrix.org/opaque-media",
        "buffer://message-send/attachment",
      ];

      await runDrySend(
        {
          message: "attachments ready",
          mediaUrls: [` ${mediaUrls[0]} `, mediaUrls[0], ...mediaUrls.slice(1), " "],
        },
        sandboxRoot,
      );

      expect(mocks.executeSendAction).toHaveBeenCalledTimes(1);
      const args = sendArgs();
      expect(args.mediaUrls).toEqual(mediaUrls);
      expect(requireRecord(args.payload).mediaUrls).toEqual(mediaUrls);
      expect(requireRecord(args.payload)).not.toHaveProperty("attachments");
    },
  );

  it.each([false, true])(
    "rejects a later invalid media hint before any dispatch (sandbox=%s)",
    async (sandboxed) => {
      await withSandbox(async (sandboxDir) => {
        await expect(
          runDrySend(
            {
              message: "must not send partially",
              mediaUrls: [
                "https://example.com/first.png",
                " data:text/plain;base64,QQ== ",
                "https://example.com/last.png",
              ],
            },
            sandboxed ? sandboxDir : undefined,
          ),
        ).rejects.toThrow("data: URLs are not supported for media. Use buffer instead.");
        expect(mocks.executeSendAction).not.toHaveBeenCalled();
        expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
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
  afterEach(() => setActivePluginRegistry(createTestRegistry([])));
  describe("plugin-owned media-source discovery routing", () => {
    const runProfile = (
      params: Record<string, unknown>,
      options: Partial<Omit<Parameters<typeof runMessageAction>[0], "params">> = {},
    ) =>
      runMessageAction({
        cfg: {},
        action: "set-profile",
        ...options,
        params: { channel: "profile-demo", ...params },
      });
    const profilePlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "profile-demo",
        label: "Profile Demo",
        config: {
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

    it("rewrites plugin-owned sandbox media params and preserves mxc URLs", async () => {
      await withSandbox(async (sandboxDir) => {
        const result = await runProfile(
          {
            avatarPath: "/workspace/avatars/profile.png",
            avatarUrl: "mxc://matrix.org/abc123def456",
          },
          { sandboxRoot: sandboxDir },
        );

        expect(requireActionPayload(result)).toMatchObject({
          ok: true,
          avatarPath: path.join(sandboxDir, "avatars", "profile.png"),
          avatarUrl: "mxc://matrix.org/abc123def456",
        });
      });
    });

    it("routes plugin-owned host media hints into local-root expansion", async () => {
      await withSandbox(async (tempDir) => {
        const avatarPath = path.join(tempDir, "profile.png");
        await fs.writeFile(avatarPath, onePixelPng);

        const result = await runProfile(
          { avatarPath },
          {
            cfg: { tools: { fs: { workspaceOnly: false } } },
          },
        );

        const mediaLocalRoots = requireActionPayload(result).mediaLocalRoots;
        expect(Array.isArray(mediaLocalRoots)).toBe(true);
        expect(mediaLocalRoots).toContain(tempDir);
      }, "msg-profile-media-");
    });

    it("does not apply set-profile media params to send actions", async () => {
      await withSandbox(async (sandboxDir) => {
        const avatarUrl = "data:text/plain;base64,SGVsbG8=";
        const result = await runProfile(
          { target: "@profile-demo", message: "hi", avatarUrl },
          {
            action: "send",
            dryRun: true,
            sandboxRoot: sandboxDir,
          },
        );

        const sent = sendResult(result);
        expect(sent.channel).toBe("profile-demo");
      });
    });
  });

  describe("sandboxed media validation", () => {
    beforeEach(() => {
      setTestPlugin(workspacePlugin, "workspace");
    });

    it.each([
      ["media", "/etc/passwd"],
      ["mediaUrl", "/etc/passwd"],
      ["mediaUrl", "file:///etc/passwd"],
      ["fileUrl", "file:///etc/passwd"],
    ])("rejects out-of-sandbox %s reference: %s", async (mediaField, media) => {
      await withSandbox(async (sandboxDir) => {
        await expect(
          runDrySend(
            {
              [mediaField]: media,
              message: "",
            },
            sandboxDir,
          ),
        ).rejects.toThrow(/sandbox/i);
      });
    });

    it("prefers media over mediaUrl when both aliases are present", async () => {
      await withSandbox(async (sandboxDir) => {
        const result = await runDrySend(
          {
            media: "./data/primary.txt",
            mediaUrl: "./data/secondary.txt",
            message: "",
          },
          sandboxDir,
        );

        const sent = sendResult(result);
        expect(sent?.mediaUrl).toBe(path.join(sandboxDir, "data", "primary.txt"));
      });
    });

    it.each(["mediaUrl", "fileUrl"])(
      "keeps remote HTTP %s aliases unchanged under sandbox validation",
      async (mediaField) => {
        await withSandbox(async (sandboxDir) => {
          const remoteUrl = "https://example.com/files/report.pdf?sig=1";
          const result = await runDrySend(
            {
              [mediaField]: remoteUrl,
              message: "",
            },
            sandboxDir,
          );

          const sent = sendResult(result);
          expect(sent?.mediaUrl).toBe(remoteUrl);
        });
      },
    );

    it("allows media paths under preferred OpenClaw tmp root", async () => {
      const tmpRoot = resolvePreferredOpenClawTmpDir();
      await fs.mkdir(tmpRoot, { recursive: true });
      await withSandbox(async (sandboxDir) => {
        const tmpFile = path.join(tmpRoot, "test-media-image.png");
        const result = await runDrySend({ media: tmpFile, message: "" }, sandboxDir);

        const sent = sendResult(result);
        expect(sent?.mediaUrl).toBe(path.resolve(tmpFile));
        const hostTmpOutsideOpenClaw = path.join(os.tmpdir(), "outside-openclaw", "test-media.png");
        await expect(
          runDrySend({ media: hostTmpOutsideOpenClaw, message: "" }, sandboxDir),
        ).rejects.toThrow(/sandbox/i);
      });
    });
  });
});
