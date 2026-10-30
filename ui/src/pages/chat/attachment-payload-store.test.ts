/* @vitest-environment jsdom */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import * as videoPosters from "../../lib/media/video-poster.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  cloneChatAttachmentsForIndependentOwner,
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  getChatAttachmentVideoPosterUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
  replaceChatAttachmentsFromEditor,
} from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { AssistantAttachments } from "./components/chat-message-attachments-solid.tsx";
import { stubObjectUrls } from "./components/chat-message-media.test-helpers.ts";
import { projectMessageMedia } from "./components/chat-message-media.ts";
import { hydrateDurableComposerAttachments } from "./durable-composer-persistence.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

const dataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
const pdfMetadata = { mimeType: "application/pdf", fileName: "brief.pdf", sizeBytes: 9 };
const pdf = { id: "synthetic-pdf", ...pdfMetadata };
let created: Map<string, Blob>;
let revoked: string[];
let owned: ChatAttachment[];
let browserBlob: typeof Blob;
beforeEach(() => {
  browserBlob = Blob;
  vi.stubGlobal("sessionStorage", createStorageMock());
  installOutboxBrowserStorage();
  created = new Map();
  revoked = [];
  owned = [];
  stubObjectUrls(
    (blob) => {
      assert(blob instanceof Blob);
      const value = `blob:http://localhost/preview-${created.size}`;
      created.set(value, blob);
      return value;
    },
    vi.fn((value: string) => revoked.push(value)),
  );
});
afterEach(() => {
  releaseChatAttachmentPayloads(owned);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function selected(): ChatAttachment {
  const attachment = registerChatAttachmentPayload({
    attachment: { ...pdf },
    dataUrl,
    file: new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" }),
  });
  owned.push(attachment);
  return attachment;
}
it("retains document Open and Download after complete outbox hydration", async () => {
  const host = makeChatHost({
    requestHandlers: {},
    settings: { gatewayUrl: "ws://synthetic-preview.test" },
    sessionKey: "agent:main:preview",
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
  });
  assert(host.client, "Missing fixture client");
  vi.spyOn(host.client, "recoveryScope", "get").mockReturnValue("synthetic-preview-owner");
  const item: ChatQueueItem = {
    id: "synthetic-queue",
    text: "Read brief",
    createdAt: 1,
    sessionKey: host.sessionKey,
    agentId: "main",
    attachments: [selected()],
  };
  const persisted = await prepareOutboxPayload(host, item);
  assert(persisted.status === "ready", "Payload was not persisted");
  releaseChatAttachmentPayloads(item.attachments);
  const restored = await prepareOutboxPayload(
    host,
    { ...item, ...persisted.update, attachments: [{ ...pdf }] },
    "handoff",
  );
  assert(restored.status === "ready", "Payload was not restored");
  const attachment = restored.update.attachments?.[0];
  assert(attachment, "Missing restored attachment");
  owned.push(attachment);
  expect(getChatAttachmentDataUrl(attachment)).toBe(dataUrl);
  expect(attachment).toMatchObject(pdf);
  const message = buildLocalUserMessage({
    attachments: [attachment],
    createdAt: 1,
    text: "Read brief",
  });
  const { attachments } = projectMessageMedia(message, normalizeMessage(message).content);
  const onOpen = vi.fn();
  const { container } = mountSolid(() =>
    createComponent(AssistantAttachments, { attachments, options: {}, onOpenSidebar: onOpen }),
  );
  flush();
  const download = container.querySelector<HTMLAnchorElement>(
    ".chat-assistant-attachment-card__download",
  );
  const open = container.querySelector<HTMLButtonElement>(
    ".chat-assistant-attachment-card__expand",
  );
  expect(container.textContent).toContain("brief.pdf");
  assert(download, "restored PDF Download must remain available");
  assert(open, "restored PDF Open must remain available");
  const href = download.getAttribute("href")!;
  expect(href).toMatch(/^blob:/);
  const blob = created.get(href);
  expect(blob).toBeDefined();
  expect(
    createHash("sha256")
      .update(new Uint8Array(await blob!.arrayBuffer()))
      .digest("hex"),
  ).toBe("e5c62df5dab5c87b6a015ef3d43597074d1eec433b15f51aec63b8582d0e4ab4");
  open!.click();
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "attachment", src: href, title: "brief.pdf" }),
  );
  releaseChatAttachmentPayloads([attachment]);
  expect(revoked.filter((value) => value === href)).toHaveLength(1);
});

it("keeps restored and independently cloned preview ownership separate", async () => {
  const [restored] = await hydrateDurableComposerAttachments([
    { blob: new browserBlob(["%PDF-1.4\n"]), ...pdfMetadata },
  ]);
  assert(restored, "Missing restored draft");
  owned.push(restored);
  expect(created.size).toBe(0);
  expect(getChatAttachmentDataUrl(restored)).toBe(dataUrl);
  const [clone] = cloneChatAttachmentsForIndependentOwner([restored]);
  assert(clone, "Missing independent attachment");
  owned.push(clone);
  expect(clone.id).not.toBe(restored.id);
  const first = getChatAttachmentPreviewUrl(restored);
  const second = getChatAttachmentPreviewUrl(clone);
  expect(first).toMatch(/^blob:/);
  expect(second).toMatch(/^blob:/);
  expect(second).not.toBe(first);
  expect(getChatAttachmentPreviewUrl(restored)).toBe(first);
  expect(created.size).toBe(2);
  releaseChatAttachmentPayloads([restored]);
  expect(revoked).toEqual([first]);
  expect(getChatAttachmentPreviewUrl(clone)).toBe(second);
  releaseChatAttachmentPayloads([clone]);
  expect(revoked).toEqual([first, second]);
});

it("retains inline previews when object URLs are unavailable", () => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: undefined });
  const attachment = selected();
  expect(getChatAttachmentPreviewUrl(attachment)).toBe(dataUrl);
  expect(created.size).toBe(0);
  releaseChatAttachmentPayloads([attachment]);
  expect(revoked).toEqual([]);
});

it("retains a pending video poster when a local message projects the same payload", async () => {
  const ready = createDeferred<Blob | null>();
  vi.spyOn(videoPosters, "requestVideoPoster").mockReturnValue(ready.promise);
  const file = new File(["synthetic video"], "demo.mp4", { type: "video/mp4" });
  const attachment = registerChatAttachmentPayload({
    attachment: { id: "pending-video", fileName: file.name, mimeType: file.type },
    dataUrl: "data:video/mp4;base64,c3ludGhldGljIHZpZGVv",
    file,
  });
  owned.push(attachment);
  const pending = getChatAttachmentVideoPosterUrl(attachment);
  buildLocalUserMessage({ attachments: [attachment], createdAt: 1, text: "Inspect the video" });
  const poster = new Blob(["synthetic poster"], { type: "image/jpeg" });
  ready.resolve(poster);
  const url = await pending;
  expect(url).not.toBeNull();
  expect(created.get(url!)).toBe(poster);
  releaseChatAttachmentPayloads([attachment]);
  expect(new Set(revoked)).toEqual(new Set(created.keys()));
});

it.each([0, 1])("restores images only within the 5 MiB cap (extra bytes: %i)", (extra) => {
  const data = Buffer.alloc(5 * 1024 * 1024 + extra, 0xab).toString("base64");
  const restored = replaceChatAttachmentsFromEditor([], [{ mimeType: "image/png", data }]);
  owned.push(...restored);
  if (extra) {
    expect(restored).toEqual([]);
  } else {
    expect(restored).toHaveLength(1);
    expect(getChatAttachmentDataUrl(restored[0]!)).toBe(`data:image/png;base64,${data}`);
  }
});
