import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";

vi.mock("../../media/web-media.js", async () => {
  const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
    "../../media/web-media.js",
  );
  return {
    ...actual,
    loadWebMedia: vi.fn(actual.loadWebMedia),
  };
});

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

async function withSandbox(test: (sandboxDir: string) => Promise<void>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  sandboxRoot?: string;
}) =>
  runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    dryRun: true,
    sandboxRoot: params.sandboxRoot,
  });

async function expectSandboxMediaRewrite(params: {
  sandboxDir: string;
  media?: string;
  mediaField?: "media" | "mediaUrl" | "fileUrl";
  message?: string;
  expectedRelativePath: string;
}) {
  const result = await runDrySend({
    cfg: slackConfig,
    actionParams: {
      channel: "slack",
      target: "#C12345678",
      ...(params.media
        ? {
            [params.mediaField ?? "media"]: params.media,
          }
        : {}),
      ...(params.message ? { message: params.message } : {}),
    },
    sandboxRoot: params.sandboxDir,
  });

  expect(result.kind).toBe("send");
  if (result.kind !== "send") {
    throw new Error("expected send result");
  }
  expect(result.sendResult?.mediaUrl).toBe(
    path.join(params.sandboxDir, params.expectedRelativePath),
  );
}

type MessageActionRunnerModule = typeof import("./message-action-runner.js");
type WebMediaModule = typeof import("../../media/web-media.js");

let runMessageAction: MessageActionRunnerModule["runMessageAction"];
let loadWebMedia: WebMediaModule["loadWebMedia"];

const slackPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "slack",
    label: "Slack",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => cfg.channels?.slack ?? {},
      isConfigured: async (account) =>
        typeof (account as { botToken?: unknown }).botToken === "string" &&
        (account as { botToken?: string }).botToken!.trim() !== "" &&
        typeof (account as { appToken?: unknown }).appToken === "string" &&
        (account as { appToken?: string }).appToken!.trim() !== "",
    },
  }),
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("missing target for slack"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async () => ({ channel: "slack", messageId: "msg-test" }),
    sendMedia: async () => ({ channel: "slack", messageId: "msg-test" }),
  },
};

describe("runMessageAction media behavior", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ runMessageAction } = await import("./message-action-runner.js"));
    ({ loadWebMedia } = await import("../../media/web-media.js"));
    vi.clearAllMocks();
  });

  describe("sendAttachment hydration", () => {
    const cfg = {
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    } as OpenClawConfig;
    const attachmentPlugin: ChannelPlugin = {
      id: "bluebubbles",
      meta: {
        id: "bluebubbles",
        label: "BlueBubbles",
        selectionLabel: "BlueBubbles",
        docsPath: "/channels/bluebubbles",
        blurb: "BlueBubbles test plugin.",
      },
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["sendAttachment", "setGroupIcon"] }),
        supportsAction: ({ action }) => action === "sendAttachment" || action === "setGroupIcon",
        handleAction: async ({ params }) =>
          jsonResult({
            ok: true,
            buffer: params.buffer,
            filename: params.filename,
            caption: params.caption,
            contentType: params.contentType,
          }),
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "bluebubbles",
            source: "test",
            plugin: attachmentPlugin,
          },
        ]),
      );
      vi.mocked(loadWebMedia).mockResolvedValue({
        buffer: Buffer.from("hello"),
        contentType: "image/png",
        kind: "image",
        fileName: "pic.png",
      });
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    async function restoreRealMediaLoader() {
      const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
        "../../media/web-media.js",
      );
      vi.mocked(loadWebMedia).mockImplementation(actual.loadWebMedia);
    }

    async function expectRejectsLocalAbsolutePathWithoutSandbox(params: {
      action: "sendAttachment" | "setGroupIcon";
      target: string;
      mediaField?: "media" | "mediaUrl" | "fileUrl";
      message?: string;
      tempPrefix: string;
    }) {
      await restoreRealMediaLoader();

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix));
      try {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        const actionParams: Record<string, unknown> = {
          channel: "bluebubbles",
          target: params.target,
          [params.mediaField ?? "media"]: outsidePath,
        };
        if (params.message) {
          actionParams.message = params.message;
        }

        await expect(
          runMessageAction({
            cfg,
            action: params.action,
            params: actionParams,
          }),
        ).rejects.toThrow(/allowed directory|path-not-allowed/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }

    it("hydrates buffer and filename from media for sendAttachment", async () => {
      const result = await runMessageAction({
        cfg,
        action: "sendAttachment",
        params: {
          channel: "bluebubbles",
          target: "+15551234567",
          media: "https://example.com/pic.png",
          message: "caption",
        },
      });

      expect(result.kind).toBe("action");
      expect(result.payload).toMatchObject({
        ok: true,
        filename: "pic.png",
        caption: "caption",
        contentType: "image/png",
      });
      expect((result.payload as { buffer?: string }).buffer).toBe(
        Buffer.from("hello").toString("base64"),
      );
      const call = vi.mocked(loadWebMedia).mock.calls[0];
      expect(call?.[1]).toEqual(
        expect.objectContaining({
          localRoots: expect.any(Array),
        }),
      );
      expect((call?.[1] as { sandboxValidated?: boolean } | undefined)?.sandboxValidated).not.toBe(
        true,
      );
    });

    it("enforces sandboxed attachment paths for attachment actions", async () => {
      for (const testCase of [
        {
          name: "sendAttachment rewrite",
          action: "sendAttachment" as const,
          target: "+15551234567",
          media: "./data/pic.png",
          message: "caption",
          expectedPath: path.join("data", "pic.png"),
        },
        {
          name: "sendAttachment mediaUrl rewrite",
          action: "sendAttachment" as const,
          target: "+15551234567",
          mediaField: "mediaUrl" as const,
          media: "./data/pic.png",
          message: "caption",
          expectedPath: path.join("data", "pic.png"),
        },
        {
          name: "sendAttachment fileUrl rewrite",
          action: "sendAttachment" as const,
          target: "+15551234567",
          mediaField: "fileUrl" as const,
          media: "/workspace/files/report.pdf",
          message: "caption",
          expectedPath: path.join("files", "report.pdf"),
        },
        {
          name: "setGroupIcon rewrite",
          action: "setGroupIcon" as const,
          target: "group:123",
          media: "./icons/group.png",
          expectedPath: path.join("icons", "group.png"),
        },
      ]) {
        vi.mocked(loadWebMedia).mockClear();
        await withSandbox(async (sandboxDir) => {
          await runMessageAction({
            cfg,
            action: testCase.action,
            params: {
              channel: "bluebubbles",
              target: testCase.target,
              [testCase.mediaField ?? "media"]: testCase.media,
              ...(testCase.message ? { message: testCase.message } : {}),
            },
            sandboxRoot: sandboxDir,
          });

          const call = vi.mocked(loadWebMedia).mock.calls[0];
          expect(call?.[0], testCase.name).toBe(path.join(sandboxDir, testCase.expectedPath));
          expect(call?.[1], testCase.name).toEqual(
            expect.objectContaining({
              sandboxValidated: true,
            }),
          );
        });
      }

      for (const testCase of [
        {
          action: "sendAttachment" as const,
          target: "+15551234567",
          message: "caption",
          tempPrefix: "msg-attachment-",
        },
        {
          action: "sendAttachment" as const,
          target: "+15551234567",
          mediaField: "mediaUrl" as const,
          message: "caption",
          tempPrefix: "msg-attachment-media-url-",
        },
        {
          action: "sendAttachment" as const,
          target: "+15551234567",
          mediaField: "fileUrl" as const,
          message: "caption",
          tempPrefix: "msg-attachment-file-url-",
        },
        {
          action: "setGroupIcon" as const,
          target: "group:123",
          tempPrefix: "msg-group-icon-",
        },
      ]) {
        await expectRejectsLocalAbsolutePathWithoutSandbox(testCase);
      }
    });
  });

  describe("sandboxed media validation", () => {
    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "slack",
            source: "test",
            plugin: slackPlugin,
          },
        ]),
      );
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
            cfg: slackConfig,
            actionParams: {
              channel: "slack",
              target: "#C12345678",
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
          cfg: slackConfig,
          actionParams: {
            channel: "slack",
            target: "#C12345678",
            media: "data:image/png;base64,abcd",
            message: "",
          },
        }),
      ).rejects.toThrow(/data:/i);
    });

    it("rewrites in-sandbox media references before dry send", async () => {
      for (const testCase of [
        {
          name: "relative media path",
          media: "./data/file.txt",
          message: "",
          expectedRelativePath: path.join("data", "file.txt"),
        },
        {
          name: "relative mediaUrl path",
          mediaField: "mediaUrl" as const,
          media: "./data/file.txt",
          message: "",
          expectedRelativePath: path.join("data", "file.txt"),
        },
        {
          name: "/workspace fileUrl path",
          mediaField: "fileUrl" as const,
          media: "/workspace/data/file.txt",
          message: "",
          expectedRelativePath: path.join("data", "file.txt"),
        },
        {
          name: "/workspace media path",
          media: "/workspace/data/file.txt",
          message: "",
          expectedRelativePath: path.join("data", "file.txt"),
        },
        {
          name: "MEDIA directive",
          message: "Hello\nMEDIA: ./data/note.ogg",
          expectedRelativePath: path.join("data", "note.ogg"),
        },
      ] as const) {
        await withSandbox(async (sandboxDir) => {
          await expectSandboxMediaRewrite({
            sandboxDir,
            media: testCase.media,
            mediaField: testCase.mediaField,
            message: testCase.message,
            expectedRelativePath: testCase.expectedRelativePath,
          });
        });
      }
    });

    it("prefers media over mediaUrl when both aliases are present", async () => {
      await withSandbox(async (sandboxDir) => {
        const result = await runDrySend({
          cfg: slackConfig,
          actionParams: {
            channel: "slack",
            target: "#C12345678",
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
            cfg: slackConfig,
            actionParams: {
              channel: "slack",
              target: "#C12345678",
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
          cfg: slackConfig,
          action: "send",
          params: {
            channel: "slack",
            target: "#C12345678",
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
            cfg: slackConfig,
            action: "send",
            params: {
              channel: "slack",
              target: "#C12345678",
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
