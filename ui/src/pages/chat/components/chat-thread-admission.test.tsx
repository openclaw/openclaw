/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { mountChatThread } from "./chat-thread.test-support.ts";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  cleanupSolid();
  resetTranscriptTestDom();
});

function admissionFixture(initial: Partial<ChatThreadProps>) {
  // Cheap preparation must not skip the boundary before constructing real rows.
  vi.spyOn(performance, "now").mockReturnValue(0);
  const pending = Promise.withResolvers<void>();
  const yieldTask = vi.fn(() => pending.promise);
  vi.stubGlobal("scheduler", { yield: yieldTask });
  const transcript = createChatTranscript(() => "row-admission");
  transcript.start();
  onTestFinished(() => transcript.dispose());
  const props = threadProps("row-admission", "agent:main:row-admission", [], {
    selectedSession: { key: "agent:main:row-admission", kind: "direct", hasMessages: true },
    ...initial,
  });
  return { ...mountChatThread(props, transcript), props, pending, yieldTask };
}

const history = (text: string) => [
  { id: "message-1", role: "assistant", content: text, timestamp: 1 },
];

it.each(["loading", "empty", "paginated"])(
  "splits the first populated history after an initial %s projection",
  async (initial) => {
    const view = admissionFixture({
      loading: initial === "loading",
      historyPagination:
        initial === "paginated"
          ? { hasMore: true, loading: false, onShowEarlier: () => {} }
          : undefined,
    });
    expect(view.yieldTask).not.toHaveBeenCalled();
    const viewport = view.container.querySelector(".chat-thread-viewport");
    view.update({ ...view.props, loading: false, messages: history("First history") });
    expect(view.yieldTask).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".chat-virtual-row")).toBeNull();

    view.update({
      ...view.props,
      loading: false,
      messages: history("Latest history"),
      commentAttachments: [],
    });
    expect(view.yieldTask).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".chat-thread--annotations")).not.toBeNull();
    view.pending.resolve();
    await waitForSolid(() => expect(view.container.textContent).toContain("Latest history"));
    expect(view.container.textContent).not.toContain("First history");
    const row = view.container.querySelector(".chat-virtual-row");
    expect(row).not.toBeNull();
    view.update({ ...view.props, loading: false, messages: history("Updated history") });
    await waitForSolid(() => expect(view.container.textContent).toContain("Updated history"));
    expect(view.container.querySelector(".chat-thread-viewport")).toBe(viewport);
    expect(view.container.querySelector(".chat-virtual-row")).toBe(row);
    expect(view.yieldTask).toHaveBeenCalledOnce();
  },
);

it.each(["mount", "dispose", "replace"])(
  "settles populated cold admission after %s",
  async (mode) => {
    const view = admissionFixture({ messages: history("Populated history") });
    expect(view.yieldTask).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".chat-virtual-row")).toBeNull();
    if (mode === "dispose") {
      view.unmount();
    } else if (mode === "replace") {
      view.update({
        ...view.props,
        sessionKey: "agent:main:replacement",
        selectedSession: { key: "agent:main:replacement", kind: "direct", hasMessages: true },
        messages: history("Replacement history"),
      });
    }
    view.pending.resolve();
    await view.pending.promise;
    await Promise.resolve();
    flush();
    if (mode === "dispose") {
      expect(view.container.querySelector(".chat-virtual-row")).toBeNull();
    } else {
      await waitForSolid(() =>
        expect(view.container.textContent).toContain(
          mode === "replace" ? "Replacement history" : "Populated history",
        ),
      );
      if (mode === "replace") {
        expect(view.container.textContent).not.toContain("Populated history");
      }
    }
    expect(view.yieldTask).toHaveBeenCalledOnce();
  },
);

it.each(["restored", "submitted"])("mounts %s first rows immediately", (mode) => {
  const view = admissionFixture({
    messages: history("Immediate history"),
    restoring: mode === "restored",
    initialSubmission: mode === "submitted",
  });
  expect(view.yieldTask).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("Immediate history");
});
