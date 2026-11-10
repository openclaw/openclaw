import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";
import { ChatTranscriptFeed } from "./chat-transcript-feed-view.tsx";

afterEach(() => vi.restoreAllMocks());

it("formats chat labels, context accessibility text, and transcript times with the UI locale", () => {
  vi.spyOn(i18n, "getLocale").mockReturnValue("de");
  const timestamp = Date.UTC(2020, 2, 4, 12, 34, 56);
  const date = new Date(timestamp);
  const view = mountSolid(() => (
    <>
      <ChatTimestamp timestamp={timestamp} metadata={[<span>Usage</span>]} />
      <ChatTranscriptFeed
        messages={[{ role: "user", timestamp, content: [{ type: "text", text: "Hello" }] }]}
      />
    </>
  ));
  try {
    expect(view.container.querySelector(".chat-group-timestamp")?.textContent).toBe(
      date.toLocaleDateString("de", { month: "short", day: "numeric", year: "numeric" }),
    );
    expect(view.container.querySelector(".msg-meta__time")?.textContent).toBe(
      date.toLocaleString("de", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    );
    expect(view.container.querySelector(".msg-meta__summary")?.getAttribute("aria-label")).toBe(
      t("chat.messages.contextFor", {
        timestamp: date.toLocaleString("de", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        }),
      }),
    );
    expect(view.container.querySelector(".chat-task-feed time")?.textContent).toBe(
      date.toLocaleTimeString("de", { hour: "2-digit", minute: "2-digit", hour12: false }),
    );
  } finally {
    view.unmount();
  }
});
