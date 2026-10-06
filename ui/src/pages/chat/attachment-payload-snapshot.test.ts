import { afterEach, expect, it } from "vitest";
import {
  getChatAttachmentBlob,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
const attachment = { id: "snapshot-fixture", mimeType: "image/png" };
afterEach(() => releaseChatAttachmentPayloads([attachment]));
it("persists the completed image read instead of retaining its file-backed source", async () => {
  const file = new File(["changed source"], "fixture.png", { type: "image/png" });
  registerChatAttachmentPayload({
    attachment,
    file,
    dataUrl: "data:image/png;base64,b3JpZ2luYWw=",
  });
  const blob = getChatAttachmentBlob(attachment);
  expect(blob).not.toBe(file);
  expect(await blob!.text()).toBe("original");
  expect(blob!.type).toBe("image/png");
});
it("keeps non-image file ownership for video posters", () => {
  const file = new File(["video"], "fixture.mp4", { type: "video/mp4" });
  registerChatAttachmentPayload({ attachment, file, dataUrl: "data:video/mp4;base64,dmlkZW8=" });
  expect(getChatAttachmentBlob(attachment)).toBe(file);
});
