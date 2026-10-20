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
let file: File;
let attachment: ChatAttachment;
let created: Blob[];
let revoked: string[];
let moduleReady: ReturnType<typeof createDeferred<VideoPosterModule>>;
let importStarted: ReturnType<typeof createDeferred<void>>;
let posterReady: ReturnType<typeof createDeferred<Blob | null>>;
let request: ReturnType<typeof vi.fn<VideoPosterModule["requestVideoPoster"]>>;
let pending: ReturnType<typeof getChatAttachmentVideoPosterUrl>;

beforeEach(() => {
  file = new File(["video"], "clip.mp4", { type: "video/mp4" });
  attachment = { id: "loading-video", fileName: file.name, mimeType: file.type };
  created = [];
  revoked = [];
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL(blob: Blob) {
        created.push(blob);
        return `blob:poster-source-${created.length}`;
      }
      static override revokeObjectURL(url: string) {
        revoked.push(url);
      }
    },
  );
  moduleReady = createDeferred<VideoPosterModule>();
  importStarted = createDeferred<void>();
  posterReady = createDeferred<Blob | null>();
  request = vi.fn<VideoPosterModule["requestVideoPoster"]>(() => posterReady.promise);
  vi.doMock("../../lib/media/video-poster.ts", () => {
    importStarted.resolve();
    return moduleReady.promise;
  });
  registerChatAttachmentPayload({ attachment, file, dataUrl: "data:video/mp4;base64,dmlkZW8=" });
  pending = getChatAttachmentVideoPosterUrl(attachment);
});
afterEach(async () => {
  releaseChatAttachmentPayloads([attachment]);
  moduleReady.resolve({ requestVideoPoster: request });
  posterReady.resolve(null);
  await pending;
  vi.doUnmock("../../lib/media/video-poster.ts");
  vi.unstubAllGlobals();
});

it.each(["module", "poster"] as const)(
  "retains the source URL until the %s promise settles after owner release",
  async (phase) => {
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
    expect({ created, revoked }).toEqual({ created: [file], revoked: ["blob:poster-source-1"] });
  },
);

it("keeps the video payload when the poster module cannot load", async () => {
  await importStarted.promise;
  moduleReady.reject(new Error("Synthetic poster chunk unavailable"));
  await expect(pending).resolves.toBeNull();
  expect(getChatAttachmentBlob(attachment)).toBe(file);
  expect(getChatAttachmentVideoPosterUrl(attachment)).toBe(pending);
  expect({ created, revoked }).toEqual({ created: [file], revoked: ["blob:poster-source-1"] });
  releaseChatAttachmentPayloads([attachment]);
  expect(revoked).toEqual(["blob:poster-source-1"]);
});
