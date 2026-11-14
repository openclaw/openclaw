/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type {
  BrowserAnnotationDraft,
  BrowserAnnotationEvent,
} from "../../components/browser/browser-annotation.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import * as toast from "../../lib/toast.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";
import { receiveBrowserAnnotation } from "./chat-pane-browser-annotation.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const card = {
  title: "Page",
  displayUrl: "example.com",
  markedRegionCount: 1,
  inspectedElement: false,
};
const annotations = (count: number): ChatAttachment[] =>
  Array.from({ length: count }, (_, id) => ({
    id: String(id),
    mimeType: "image/png",
    browserAnnotation: { ...card, modelContext: `Context ${id}` },
  }));

function capture(modelContext = "Page context") {
  return new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
    cancelable: true,
    detail: {
      modelContext,
      dataUrl: "data:image/png;base64,aGVsbG8=",
      fileName: "annotated-page.png",
      card: { ...card },
    },
  });
}

it("includes the candidate in both the four-card and 8,000-character bounds", () => {
  expect(canAdmitBrowserAnnotation([], "x".repeat(8_000))).toBe(true);
  expect(canAdmitBrowserAnnotation([], "x".repeat(8_001))).toBe(false);
  expect(canAdmitBrowserAnnotation(annotations(3), "fourth")).toBe(true);
  expect(canAdmitBrowserAnnotation(annotations(4), "fifth")).toBe(false);
});

it("marks an active-pane rejection without allocating or consuming the capture", () => {
  const state = { chatAttachments: annotations(4) } as unknown as ChatPageHost;
  const event = capture("Rejected context");
  const replaceAttachments = vi.fn();
  expect(receiveBrowserAnnotation(state, true, event, 0, replaceAttachments)).toBe(false);
  expect(replaceAttachments).not.toHaveBeenCalled();
  expect(event as BrowserAnnotationEvent).toMatchObject({
    defaultPrevented: false,
    rejection: "limit",
  });
  expect(state.chatAttachments).toHaveLength(4);
});

it("counts in-flight reads against the send's frame budget", () => {
  const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
  // 12 bytes over the envelope slack leaves a 9-byte decoded budget; the capture decodes to 5.
  const state = {
    chatAttachments: [],
    hello: {
      policy: { maxPayload: 256 * 1024 + 12, attachments: { maxBytes: 100, maxImageBytes: 100 } },
    },
  } as unknown as ChatPageHost;
  const replaceAttachments = (attachments: ChatAttachment[]) => {
    state.chatAttachments = attachments;
  };

  const rejected = capture();
  expect(receiveBrowserAnnotation(state, true, rejected, 5, replaceAttachments)).toBe(false);
  expect(rejected.defaultPrevented).toBe(false);
  expect(state.chatAttachments).toEqual([]);
  expect(showToast).toHaveBeenCalledExactlyOnceWith({
    message: "File too large. Try a smaller file.",
    placement: "top-center",
    severity: "error",
  });

  expect(receiveBrowserAnnotation(state, true, capture(), 0, replaceAttachments)).toBe(true);
  expect(state.chatAttachments).toHaveLength(1);
});
