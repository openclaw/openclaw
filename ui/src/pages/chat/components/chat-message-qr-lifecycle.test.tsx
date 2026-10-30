/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import * as media from "./chat-message-media.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("does not acquire a media subscriber when a rendered message retires before effects settle", () => {
  const observe = vi.spyOn(media, "observeChatMediaResourceSubscriber");
  const view = mountSolid(() => (
    <GroupedMessage
      preparation={prepareChatMessageRender({ role: "assistant", content: "Ready immediately" })}
      messageKey="retired-before-effects"
      options={{ isStreaming: false, showReasoning: false }}
    />
  ));
  try {
    expect(view.container.textContent).toContain("Ready immediately");
    expect(observe).not.toHaveBeenCalled();
    view.unmount();
    flush();
    expect(observe).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("keeps another pane's QR expiry alive when one message retires", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T05:00:00Z"));
  const messageKey = "shared-pairing-expiry";
  const firstOwner = {};
  const initialOwner = {};
  const [owner, setOwner] = createSignal(initialOwner);
  const preparation = prepareChatMessageRender({
    role: "assistant",
    content: [
      {
        type: "openclaw_pairing_qr",
        image_url: "data:image/png;base64,cXJwbmc=",
        expiresAtMs: Date.now() + 1_000,
      },
    ],
  });
  const first = mountSolid(() => (
    <GroupedMessage
      preparation={preparation}
      messageKey={messageKey}
      options={{ isStreaming: false, showReasoning: false, mediaOwner: firstOwner }}
    />
  ));
  const second = mountSolid(() => (
    <GroupedMessage
      preparation={preparation}
      messageKey={messageKey}
      options={{ isStreaming: false, showReasoning: false, mediaOwner: owner() }}
    />
  ));
  try {
    flush();
    const resource = media.readChatMediaResource("pairing-qr", messageKey);
    expect(resource?.subscribers.size).toBe(2);
    expect(resource?.refresh).toBeDefined();

    first.unmount();
    expect(resource?.subscribers.size).toBe(1);
    expect(resource?.refresh).toBeDefined();

    setOwner({});
    flush();
    media.releaseChatMediaResourceOwner(initialOwner);
    const current = media.readChatMediaResource("pairing-qr", messageKey);
    expect(current?.subscribers.size).toBe(1);
    expect(current?.refresh).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    flush();
    expect(second.container.textContent).toContain("Pairing QR expired");
    expect(media.readChatMediaResource("pairing-qr", messageKey)).toBeUndefined();
    expect(current?.refresh).toBeUndefined();
  } finally {
    first.unmount();
    second.unmount();
  }
});
