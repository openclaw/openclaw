/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  getChatAttachmentBlob,
  getChatAttachmentVideoPosterUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";

type VideoPosterModule = typeof import("../../lib/media/video-poster.ts");

const dataUrl = "data:video/mp4;base64,dmlkZW8=";
let owned: ChatAttachment[];
let created: Blob[];
let revoked: string[];

beforeEach(() => {
  owned = [];
  created = [];
  revoked = [];
  const NativeURL = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static override createObjectURL(blob: Blob) {
        created.push(blob);
        return `blob:poster-source-${created.length}`;
      }
      static override revokeObjectURL(url: string) {
        revoked.push(url);
      }
    },
  );
});

afterEach(() => {
  releaseChatAttachmentPayloads(owned);
  vi.doUnmock("../../lib/media/video-poster.ts");
  vi.unstubAllGlobals();
});

function selectedVideo() {
  const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
  const attachment = registerChatAttachmentPayload({
    attachment: { id: "loading-video", fileName: file.name, mimeType: file.type },
    dataUrl,
    file,
  });
  owned.push(attachment);
  return { attachment, file };
}

it.each(["module", "poster"] as const)(
  "retains the source URL until the %s promise settles after owner release",
  async (phase) => {
    const moduleReady = createDeferred<VideoPosterModule>();
    const importStarted = createDeferred();
    const posterReady = createDeferred<Blob | null>();
    const request = vi.fn<VideoPosterModule["requestVideoPoster"]>(() => posterReady.promise);
    vi.doMock("../../lib/media/video-poster.ts", () => {
      importStarted.resolve();
      return moduleReady.promise;
    });
    const { attachment, file } = selectedVideo();
    const pending = getChatAttachmentVideoPosterUrl(attachment);
    try {
      expect(pending).not.toBeNull();
      expect(getChatAttachmentVideoPosterUrl(attachment)).toBe(pending);
      await importStarted.promise;
      if (phase === "poster") {
        moduleReady.resolve({ requestVideoPoster: request });
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      }
      releaseChatAttachmentPayloads([attachment]);
      expect(revoked).toEqual([]);
      moduleReady.resolve({ requestVideoPoster: request });
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]?.[0]).toMatchObject({
        key: file,
        src: "blob:poster-source-1",
        signal: expect.objectContaining({ aborted: true }),
      });
      expect(revoked).toEqual([]);
      posterReady.resolve(new Blob(["late poster"], { type: "image/jpeg" }));
      await expect(pending).resolves.toBeNull();
      expect(created).toEqual([file]);
      expect(revoked).toEqual(["blob:poster-source-1"]);
    } finally {
      releaseChatAttachmentPayloads([attachment]);
      moduleReady.resolve({ requestVideoPoster: request });
      posterReady.resolve(null);
      await pending;
    }
  },
);

it("keeps the video payload when the poster module cannot load", async () => {
  const moduleReady = createDeferred<VideoPosterModule>();
  const importStarted = createDeferred();
  vi.doMock("../../lib/media/video-poster.ts", () => {
    importStarted.resolve();
    return moduleReady.promise;
  });
  const { attachment, file } = selectedVideo();
  const pending = getChatAttachmentVideoPosterUrl(attachment);
  try {
    await importStarted.promise;
    moduleReady.reject(new Error("Synthetic poster chunk unavailable"));
    await expect(pending).resolves.toBeNull();
    expect(getChatAttachmentBlob(attachment)).toBe(file);
    expect(getChatAttachmentVideoPosterUrl(attachment)).toBe(pending);
    expect(created).toEqual([file]);
    expect(revoked).toEqual(["blob:poster-source-1"]);
    releaseChatAttachmentPayloads([attachment]);
    expect(revoked).toEqual(["blob:poster-source-1"]);
  } finally {
    moduleReady.resolve({ requestVideoPoster: async () => null });
    await pending;
    releaseChatAttachmentPayloads([attachment]);
  }
});
