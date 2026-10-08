/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type {
  BrowserAnnotationDraft,
  BrowserAnnotationEvent,
} from "../../components/browser/browser-annotation.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import * as toast from "../../lib/toast.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";
import { receiveBrowserAnnotation } from "./chat-pane-browser-annotation.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

function annotation(id: string, modelContext = `Context ${id}`): ChatAttachment {
  return {
    id,
    mimeType: "image/png",
    browserAnnotation: {
      modelContext,
      title: `Page ${id}`,
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

function draft(modelContext: string): BrowserAnnotationDraft {
  return {
    modelContext,
    dataUrl: "data:image/png;base64,aGVsbG8=",
    fileName: "annotated-page.png",
    card: {
      title: "Example",
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

describe("browser annotation admission", () => {
  it("includes the candidate in both the four-card and 8,000-character bounds", () => {
    expect(canAdmitBrowserAnnotation([], "x".repeat(8_000))).toBe(true);
    expect(canAdmitBrowserAnnotation([], "x".repeat(8_001))).toBe(false);
    expect(
      canAdmitBrowserAnnotation(
        [annotation("one"), annotation("two"), annotation("three")],
        "fourth",
      ),
    ).toBe(true);
    expect(
      canAdmitBrowserAnnotation(
        [annotation("one"), annotation("two"), annotation("three"), annotation("four")],
        "fifth",
      ),
    ).toBe(false);
  });

  it("marks an active-pane rejection without allocating or consuming the capture", () => {
    const state = {
      chatAttachments: [
        annotation("one"),
        annotation("two"),
        annotation("three"),
        annotation("four"),
      ],
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const event = new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
      detail: draft("Rejected context"),
      cancelable: true,
    });
    expect(receiveBrowserAnnotation(state, true, event, 0)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect((event as BrowserAnnotationEvent).rejection).toBe("limit");
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
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const capture = () =>
      new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
        detail: draft("Page context"),
        cancelable: true,
      });

    const rejected = capture();
    expect(receiveBrowserAnnotation(state, true, rejected, 5)).toBe(false);
    expect(rejected.defaultPrevented).toBe(false);
    expect(state.chatAttachments).toEqual([]);
    expect(showToast).toHaveBeenCalledExactlyOnceWith({
      message: "Too large to send: annotated-page.png",
    });

    expect(receiveBrowserAnnotation(state, true, capture(), 0)).toBe(true);
    expect(state.chatAttachments).toHaveLength(1);
  });
});
