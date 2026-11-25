import { onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";

export function createStagedAttachment(id: string): ChatAttachment {
  const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
  const attachment = registerChatAttachmentPayload({
    attachment: { id, mimeType: file.type, fileName: file.name, sizeBytes: file.size },
    dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
    file,
  });
  onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
  return attachment;
}

export function createDeliveryAttachmentBatch() {
  const sources = [
    {
      fileName: "pixel.png",
      mimeType: "image/png",
      content:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh0cAAAAASUVORK5CYII=",
    },
    { fileName: "brief.pdf", mimeType: "application/pdf", content: "JVBERi0xLjQK" },
  ];
  const dataUrls = sources.map(({ mimeType, content }) => `data:${mimeType};base64,${content}`);
  const attachments = sources.map(({ fileName, mimeType, content }, index) => {
    const file = new File([Buffer.from(content, "base64")], fileName, { type: mimeType });
    return registerChatAttachmentPayload({
      attachment: { id: `delivery-attachment-${index}`, mimeType, fileName, sizeBytes: file.size },
      dataUrl: dataUrls[index]!,
      file,
    });
  });
  onTestFinished(() => releaseChatAttachmentPayloads(attachments));
  return { attachments, dataUrls };
}

export function reloadChatDocumentStorage(attachments: readonly ChatAttachment[]): void {
  const previous = sessionStorage;
  const reloaded = createStorageMock();
  for (let index = 0; index < previous.length; index += 1) {
    const key = previous.key(index);
    if (key !== null) {
      reloaded.setItem(key, previous.getItem(key)!);
    }
  }
  // A reload retains persisted metadata/IDB, not the old document's projections.
  releaseChatAttachmentPayloads(attachments);
  vi.stubGlobal("sessionStorage", reloaded);
}
