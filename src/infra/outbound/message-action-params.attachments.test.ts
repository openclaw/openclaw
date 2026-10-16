import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Covers message-action media hydration, sandbox path normalization,
// attachments, and channel/plugin media source aliases.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
import {
  createAlwaysConfiguredPluginConfig,
  messageActionRunnerMocks,
  resetMessageActionMediaMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const { hydrateAttachmentParamsForAction } = await import("./message-action-params.js");
const loadWebMedia = messageActionRunnerMocks.loadWebMedia;

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5m8gAAAABJRU5ErkJggg==",
  "base64",
);
const onePixelPngBase64 = onePixelPng.toString("base64");
const wrappedOnePixelPngBase64 = onePixelPngBase64.match(/.{1,24}/g)?.join("\r\n") ?? "";
const parameterizedPngDataUrl = `data:image/png;charset=utf-8;name=../../ignored.svg;base64,${wrappedOnePixelPngBase64}`;
const remoteMedia = {
  buffer: Buffer.from("hello"),
  contentType: "image/png",
  kind: "image" as const,
  fileName: "pic.png",
};
type ActionInput = Parameters<typeof runMessageAction>[0];
type Hydration = Parameters<typeof hydrateAttachmentParamsForAction>[0];
const hydrate = (args: Hydration["args"], overrides: Partial<Omit<Hydration, "args">> = {}) =>
  hydrateAttachmentParamsForAction({
    cfg: {},
    channel: "imessage",
    action: "send",
    dryRun: true,
    mediaPolicy: { mode: "host" },
    args,
    ...overrides,
  });

async function restoreRealMediaLoader() {
  const actual = await vi.importActual<typeof import("../../media/web-media.js")>(
    "../../media/web-media.js",
  );
  vi.mocked(loadWebMedia).mockImplementation(actual.loadWebMedia);
}

async function withSandbox(test: (sandboxDir: string) => Promise<void>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-sandbox-"));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function requireActionPayload(
  result: Awaited<ReturnType<typeof runMessageAction>>,
): Record<string, unknown> {
  expect(result.kind).toBe("action");
  if (result.kind !== "action") {
    throw new Error("expected action result");
  }
  return requireRecord(result.payload);
}

function requireLoadWebMediaOptions(): Record<string, unknown> {
  const call = requireLoadWebMediaCall();
  return requireRecord(call[1]);
}

function requireLoadWebMediaCall(): readonly unknown[] {
  const call = vi.mocked(loadWebMedia).mock.calls[0];
  if (!call) {
    throw new Error("Expected loadWebMedia to be called");
  }
  return call;
}

function expectAttachmentRemoteMediaPayload(result: Awaited<ReturnType<typeof runMessageAction>>) {
  expect(requireActionPayload(result)).toMatchObject({
    ok: true,
    filename: "pic.png",
    caption: "caption",
    contentType: "image/png",
    buffer: remoteMedia.buffer.toString("base64"),
  });
}

describe("runMessageAction media behavior", () => {
  beforeEach(async () => {
    await resetMessageActionMediaMocks();
  });

  it("normalizes image/png data URLs and infers filenames for send", async () => {
    const args: Record<string, unknown> = { buffer: parameterizedPngDataUrl };
    await hydrate(args);
    expect(args).toMatchObject({
      contentType: "image/png",
      filename: "attachment.png",
      media: "buffer://message-send/attachment",
    });
  });

  it.each(
    (["send", "sendAttachment"] as const).flatMap((action) => [
      { action, name: "mimeType", metadata: { mimeType: "image/jpeg" } },
      {
        action,
        name: "both aliases",
        metadata: { contentType: "image/jpeg", mimeType: "image/webp" },
      },
    ]),
  )("keeps $name authoritative for $action data URLs", async ({ action, metadata }) => {
    const args: Record<string, unknown> = {
      buffer: parameterizedPngDataUrl,
      ...metadata,
    };

    await hydrate(args, { action });

    expect(args.contentType).toBe("image/jpeg");
    expect(args.filename).toBe("attachment.jpg");
  });

  it.each([
    ["duplicate marker", "image/png;base64;base64"],
    ["marker before another parameter", "image/png;base64;charset=utf-8"],
    ["missing MIME type", ";base64"],
    ["metadata newline", "image/png;name=bad\r\nvalue;base64"],
  ])("rejects a data URL with a %s", async (_label, metadata) => {
    await expect(hydrate({ buffer: `data:${metadata},${onePixelPngBase64}` })).rejects.toThrow(
      /invalid base64/i,
    );
  });

  it("rejects an oversized parameterized data URL before decoding its payload", async () => {
    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      await expect(
        hydrate(
          { buffer: parameterizedPngDataUrl },
          {
            cfg: { agents: { defaults: { mediaMaxMb: 0.00001 } } },
          },
        ),
      ).rejects.toThrow(/too large|limit/i);
      const base64Calls = (fromSpy.mock.calls as ReadonlyArray<readonly unknown[]>).filter(
        (call) => call[1] === "base64",
      );
      expect(base64Calls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });

  describe("sendAttachment hydration", () => {
    const cfg = {
      channels: {
        attachmentchat: {
          enabled: true,
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    } as OpenClawConfig;
    const attachmentPlugin: ChannelPlugin = {
      id: "attachmentchat",
      meta: {
        id: "attachmentchat",
        label: "AttachmentChat",
        selectionLabel: "AttachmentChat",
        docsPath: "/channels/attachmentchat",
        blurb: "AttachmentChat test plugin.",
      },
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: createAlwaysConfiguredPluginConfig(),
      actions: {
        describeMessageTool: () => ({ actions: ["sendAttachment", "upload-file", "setGroupIcon"] }),
        supportsAction: ({ action }) =>
          action === "sendAttachment" || action === "upload-file" || action === "setGroupIcon",
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
    const runAttachment = (params: ActionInput["params"], overrides: Partial<ActionInput> = {}) =>
      runMessageAction({
        cfg,
        action: "sendAttachment",
        ...overrides,
        params: { channel: "attachmentchat", target: "+15551234567", ...params },
      });

    beforeEach(() => {
      setTestPlugin(attachmentPlugin, "attachmentchat");
      vi.mocked(loadWebMedia).mockResolvedValue(remoteMedia);
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it.each(["sendAttachment", "upload-file"] as const)(
      "delivers parameterized wrapped image data URLs through the %s handler",
      async (action) => {
        const result = await runAttachment({ buffer: parameterizedPngDataUrl }, { action });

        const payload = requireActionPayload(result);
        expect(payload.contentType).toBe("image/png");
        expect(payload.filename).toBe("attachment.png");
        expect(canonicalizeBase64(String(payload.buffer))).toBe(onePixelPngBase64);
      },
    );

    it("hydrates validated host-local text attachments when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      await withSandbox(async (tempDir) => {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        const result = await runAttachment(
          { media: outsidePath, message: "caption" },
          {
            cfg: {
              ...cfg,
              tools: { fs: { workspaceOnly: false } },
            },
          },
        );

        expect(result.kind).toBe("action");
        expect(result.payload).toMatchObject({
          ok: true,
          filename: "secret.txt",
          caption: "caption",
          contentType: "text/plain",
        });
        expect((result.payload as { buffer?: string }).buffer).toBe(
          Buffer.from("secret").toString("base64"),
        );
      });
    });

    it("keeps original upload-file bytes when forced to send as a document", async () => {
      const result = await runAttachment(
        {
          media: "https://example.com/pic.png",
          message: "caption",
          forceDocument: true,
        },
        { action: "upload-file" },
      );

      expectAttachmentRemoteMediaPayload(result);
      expect(requireLoadWebMediaOptions().optimizeImages).toBe(false);
    });

    it("enforces sandboxed attachment paths for attachment actions", async () => {
      const cases = [
        ["sendAttachment", "media", "./data/pic.png", "data", "pic.png"],
        ["sendAttachment", "mediaUrl", "./data/pic.png", "data", "pic.png"],
        ["sendAttachment", "fileUrl", "/workspace/files/report.pdf", "files", "report.pdf"],
        ["setGroupIcon", "media", "./icons/group.png", "icons", "group.png"],
      ] as const;
      const destination = (action: "sendAttachment" | "setGroupIcon") =>
        action === "sendAttachment"
          ? { target: "+15551234567", message: "caption" }
          : { target: "group:123" };
      for (const [action, field, media, directory, filename] of cases) {
        vi.mocked(loadWebMedia).mockClear();
        await withSandbox(async (sandboxDir) => {
          await runAttachment(
            { ...destination(action), [field]: media },
            { action, sandboxRoot: sandboxDir },
          );

          const call = requireLoadWebMediaCall();
          expect(call[0], `${action} ${field}`).toBe(path.join(sandboxDir, directory, filename));
          expect(requireRecord(call[1]).sandboxValidated, `${action} ${field}`).toBe(true);
        });
      }

      await restoreRealMediaLoader();
      for (const [action, field] of cases) {
        await withSandbox(async (tempDir) => {
          const outsidePath = path.join(tempDir, "secret.txt");
          await fs.writeFile(outsidePath, "secret", "utf8");
          await expect(
            runAttachment(
              { ...destination(action), [field]: outsidePath },
              { action, cfg: { tools: { fs: { workspaceOnly: true } } } },
            ),
          ).rejects.toThrow(/allowed directory|path-not-allowed/i);
        });
      }
    });
  });

  describe("reply hydration", () => {
    // Regression #79864: hydrate reply paths before plugin dispatch, enforcing
    // media policy without synthesizing attachment captions from reply text.
    const cfg: OpenClawConfig = { channels: { replychat: { enabled: true } } };
    const handleActionMock = vi.fn();
    const replyPlugin: ChannelPlugin = {
      id: "replychat",
      meta: {
        id: "replychat",
        label: "ReplyChat",
        selectionLabel: "ReplyChat",
        docsPath: "/channels/replychat",
        blurb: "ReplyChat test plugin.",
      },
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: createAlwaysConfiguredPluginConfig(),
      actions: {
        describeMessageTool: () => ({ actions: ["reply"] }),
        supportsAction: ({ action }) => action === "reply",
        handleAction: async ({ params }) => {
          handleActionMock(params);
          return jsonResult({
            ok: true,
            buffer: params.buffer,
            filename: params.filename,
            caption: params.caption,
            contentType: params.contentType,
            text: params.text,
            message: params.message,
          });
        },
      },
    };
    const runReply = (params: ActionInput["params"], overrides: Partial<ActionInput> = {}) =>
      runMessageAction({
        cfg,
        action: "reply",
        ...overrides,
        params: {
          channel: "replychat",
          target: "+15551234567",
          messageId: "parent-id",
          text: "look at this",
          ...params,
        },
      });
    const readHandlerParams = () =>
      mockFirstRecordArg(handleActionMock, "handleAction", "Expected a non-array record");

    beforeEach(() => {
      handleActionMock.mockReset();
      setTestPlugin(replyPlugin, "replychat");
      vi.mocked(loadWebMedia).mockResolvedValue(remoteMedia);
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("hydrates buffer and filename from a remote URL before the reply handler runs", async () => {
      const entered = createDeferred();
      const loaded = createDeferred<Awaited<ReturnType<typeof loadWebMedia>>>();
      const events: string[] = [];
      vi.mocked(loadWebMedia).mockImplementationOnce(() => {
        events.push("load");
        entered.resolve();
        return loaded.promise;
      });
      handleActionMock.mockImplementationOnce(() => {
        events.push("handler");
      });
      const action = runReply({
        message: "look at this",
        media: "https://example.com/pic.png",
      });
      const settled = action.then(
        () => {
          events.push("settled");
        },
        () => {
          events.push("rejected");
        },
      );

      try {
        await Promise.race([
          entered.promise,
          action.then(() => {
            throw new Error("Reply settled before the media loader started");
          }),
        ]);
        // Observe the held loader after a scheduler turn, without a wall-clock delay.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(events).toEqual(["load"]);
        expect(handleActionMock).not.toHaveBeenCalled();

        events.push("release");
        loaded.resolve(remoteMedia);
        const result = await action;
        await settled;

        expect(result.kind).toBe("action");
        expect(handleActionMock).toHaveBeenCalledTimes(1);
        expect(events).toEqual(["load", "release", "handler", "settled"]);
        const payload = requireActionPayload(result);
        expect(payload.buffer).toBe(Buffer.from("hello").toString("base64"));
        expect(payload.filename).toBe("pic.png");
        expect(payload.contentType).toBe("image/png");
        expect(payload.caption).toBeUndefined();
        expect(payload.message).toBe("look at this");
      } finally {
        // Release and join even when an ordering assertion fails before resolution.
        loaded.resolve(remoteMedia);
        await settled;
      }
    });

    it.each([
      { name: "nested MIME", metadata: {}, contentType: "image/png" },
      {
        name: "explicit MIME alias",
        metadata: { mimeType: "text/plain" },
        contentType: "text/plain",
      },
      {
        name: "contentType before mimeType",
        metadata: {
          contentType: "text/plain",
          mimeType: "application/json",
          filename: "explicit.txt",
        },
        contentType: "text/plain",
      },
    ])(
      "passes $name from attachments[] to the reply handler",
      async ({ metadata, contentType }) => {
        const result = await runReply({
          ...metadata,
          attachments: [
            {
              url: "https://example.com/pic.png",
              name: "reply.png",
              mimeType: "image/png",
            },
          ],
        });

        expect(result.kind).toBe("action");
        expect(loadWebMedia).toHaveBeenCalledWith(
          "https://example.com/pic.png",
          expect.any(Object),
        );
        expect(handleActionMock).toHaveBeenCalledTimes(1);
        expect(readHandlerParams()).toMatchObject({
          buffer: remoteMedia.buffer.toString("base64"),
          filename: metadata.filename ?? "reply.png",
          contentType,
        });
      },
    );

    it("routes attachments[] host paths into local-root expansion", async () => {
      await restoreRealMediaLoader();
      await withSandbox(async (tempDir) => {
        const attachmentPath = path.join(tempDir, "photo.png");
        await fs.writeFile(attachmentPath, onePixelPng);

        const result = await runReply(
          {
            attachments: [
              {
                path: attachmentPath,
                name: "photo.png",
                mimeType: "image/png",
              },
            ],
          },
          { cfg: { ...cfg, tools: { fs: { workspaceOnly: false } } } },
        );

        expect(result.kind).toBe("action");
        const handlerParams = readHandlerParams();
        expect(handlerParams.filename).toBe("photo.png");
        expect(handlerParams.contentType).toBe("image/png");
        expect(typeof handlerParams.buffer).toBe("string");
      });
    });

    it("rejects host paths outside mediaLocalRoots before invoking the reply handler", async () => {
      await restoreRealMediaLoader();
      await withSandbox(async (tempDir) => {
        const outsidePath = path.join(tempDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");

        await expect(
          runReply(
            { path: outsidePath },
            { cfg: { ...cfg, tools: { fs: { workspaceOnly: true } } } },
          ),
        ).rejects.toThrow(/allowed directory|path-not-allowed|workspace/i);
        expect(handleActionMock).not.toHaveBeenCalled();
      });
    });
  });
});
