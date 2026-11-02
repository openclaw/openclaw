import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { jsonResult } from "../../agents/tools/common.js";
import type {
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
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
function mediaPlugin(
  id: string,
  actions: ChannelMessageActionName[],
  handleAction: NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>,
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id,
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: createAlwaysConfiguredPluginConfig(),
    }),
    actions: {
      describeMessageTool: () => ({ actions }),
      supportsAction: ({ action }) => actions.includes(action),
      handleAction,
    },
  };
}
function attachmentPayload(params: Record<string, unknown>) {
  const { buffer, filename, caption, contentType } = params;
  return { ok: true, buffer, filename, caption, contentType };
}
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

async function withMediaFile(
  name: string,
  content: string | Buffer,
  test: (file: string) => Promise<void>,
) {
  await withSandbox(async (dir) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, content);
    await test(file);
  });
}

function createMediaAction(
  channel: string,
  action: ActionInput["action"],
  defaults: ActionInput["params"] = {},
) {
  const cfg = { channels: { [channel]: { enabled: true } } };
  return (params: ActionInput["params"], overrides: Partial<ActionInput> = {}) =>
    runMessageAction({
      cfg,
      action,
      ...overrides,
      params: { channel, target: "+15551234567", ...defaults, ...params },
    });
}
const localFileConfig = (channel: string, workspaceOnly: boolean) => ({
  channels: { [channel]: { enabled: true } },
  tools: { fs: { workspaceOnly } },
});

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function requireActionPayload(
  result: Awaited<ReturnType<typeof runMessageAction>>,
): Record<string, unknown> {
  expect(result.kind).toBe("action");
  return requireRecord(result.payload);
}

function requireLoadWebMediaCall(): readonly unknown[] {
  const call = vi.mocked(loadWebMedia).mock.calls[0];
  if (!call) {
    throw new Error("Expected loadWebMedia to be called");
  }
  return call;
}

describe("runMessageAction media behavior", () => {
  beforeEach(resetMessageActionMediaMocks);
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
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

    expect(args).toMatchObject({ contentType: "image/jpeg", filename: "attachment.jpg" });
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
    const attachmentPlugin = mediaPlugin(
      "attachmentchat",
      ["sendAttachment", "upload-file", "setGroupIcon"],
      async ({ params }) => jsonResult(attachmentPayload(params)),
    );
    const runAttachment = createMediaAction("attachmentchat", "sendAttachment");

    beforeEach(() => {
      setTestPlugin(attachmentPlugin, "attachmentchat");
      vi.mocked(loadWebMedia).mockResolvedValue(remoteMedia);
    });

    it.each(["sendAttachment", "upload-file"] as const)(
      "delivers parameterized wrapped image data URLs through the %s handler",
      async (action) => {
        const result = await runAttachment({ buffer: parameterizedPngDataUrl }, { action });

        const payload = requireActionPayload(result);
        expect(payload).toMatchObject({ contentType: "image/png", filename: "attachment.png" });
        expect(canonicalizeBase64(String(payload.buffer))).toBe(onePixelPngBase64);
      },
    );

    it("hydrates validated host-local text attachments when fs root expansion is enabled", async () => {
      await restoreRealMediaLoader();

      await withMediaFile("secret.txt", "secret", async (outsidePath) => {
        const result = await runAttachment(
          { media: outsidePath, message: "caption" },
          { cfg: localFileConfig("attachmentchat", false) },
        );

        expect(requireActionPayload(result)).toMatchObject({
          ok: true,
          filename: "secret.txt",
          caption: "caption",
          contentType: "text/plain",
          buffer: Buffer.from("secret").toString("base64"),
        });
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

      expect(requireActionPayload(result)).toMatchObject({
        ok: true,
        filename: "pic.png",
        caption: "caption",
        contentType: "image/png",
        buffer: Buffer.from("hello").toString("base64"),
      });
      expect(requireLoadWebMediaCall()[1]).toMatchObject({ optimizeImages: false });
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
        await withMediaFile("secret.txt", "secret", async (outsidePath) => {
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
    const handleActionMock = vi.fn();
    const replyPlugin = mediaPlugin("replychat", ["reply"], async ({ params }) => {
      handleActionMock(params);
      return jsonResult({
        ...attachmentPayload(params),
        text: params.text,
        message: params.message,
      });
    });
    const runReply = createMediaAction("replychat", "reply", {
      messageId: "parent-id",
      text: "look at this",
    });
    const readHandlerParams = () =>
      mockFirstRecordArg(handleActionMock, "handleAction", "Expected a non-array record");

    beforeEach(() => {
      handleActionMock.mockReset();
      setTestPlugin(replyPlugin, "replychat");
      vi.mocked(loadWebMedia).mockResolvedValue(remoteMedia);
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

        expect(handleActionMock).toHaveBeenCalledTimes(1);
        expect(events).toEqual(["load", "release", "handler", "settled"]);
        const payload = requireActionPayload(result);
        expect(payload).toMatchObject({
          buffer: Buffer.from("hello").toString("base64"),
          filename: "pic.png",
          contentType: "image/png",
          message: "look at this",
        });
        expect(payload.caption).toBeUndefined();
      } finally {
        // Release and join even when an ordering assertion fails before resolution.
        loaded.resolve(remoteMedia);
        await settled;
      }
    });

    it.each([
      ["nested MIME", {}, "image/png", "reply.png"],
      ["explicit MIME alias", { mimeType: "text/plain" }, "text/plain", "reply.png"],
      [
        "contentType before mimeType",
        {
          contentType: "text/plain",
          mimeType: "application/json",
          filename: "explicit.txt",
        },
        "text/plain",
        "explicit.txt",
      ],
    ] as const)(
      "passes %s from attachments[] to the reply handler",
      async (_name, metadata, contentType, filename) => {
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
          filename,
          contentType,
        });
      },
    );

    it("routes attachments[] host paths into local-root expansion", async () => {
      await restoreRealMediaLoader();
      await withMediaFile("photo.png", onePixelPng, async (attachmentPath) => {
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
          { cfg: localFileConfig("replychat", false) },
        );

        expect(result.kind).toBe("action");
        const handlerParams = readHandlerParams();
        expect(handlerParams).toMatchObject({
          filename: "photo.png",
          contentType: "image/png",
        });
        expect(typeof handlerParams.buffer).toBe("string");
      });
    });

    it("rejects host paths outside mediaLocalRoots before invoking the reply handler", async () => {
      await restoreRealMediaLoader();
      await withMediaFile("secret.txt", "secret", async (outsidePath) => {
        await expect(
          runReply({ path: outsidePath }, { cfg: localFileConfig("replychat", true) }),
        ).rejects.toThrow(/allowed directory|path-not-allowed|workspace/i);
        expect(handleActionMock).not.toHaveBeenCalled();
      });
    });
  });
});
