import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderChatSendStatus } from "./chat-message-send-status.ts";

describe("renderChatSendStatus", () => {
  it.each([
    { state: "failed", label: "Not sent", actionLabel: undefined },
    { state: "failed", label: "Not sent", actionLabel: "Check failure" },
    { state: "unconfirmed", label: "Delivery unconfirmed", actionLabel: undefined },
    { state: "unconfirmed", label: "Delivery unconfirmed", actionLabel: "Check delivery" },
    { state: "waiting-reconnect", label: "Waiting for reconnect", actionLabel: undefined },
  ] as const)(
    "shows a $state footer with its diagnostic and recovery actions ($actionLabel)",
    ({ state, label, actionLabel }) => {
      const container = document.createElement("div");
      const onRetryQueuedMessage = vi.fn();
      const onDiscardQueuedMessage = vi.fn();
      render(
        renderChatSendStatus(
          { id: "attempted-send", state, error: "Delivery diagnostic" },
          {
            onRetryQueuedMessage,
            onDiscardQueuedMessage,
            queuedMessageAction: actionLabel
              ? { id: "attempted-send", label: actionLabel }
              : undefined,
          },
        ),
        container,
      );

      const status = container.querySelector<HTMLElement>(".chat-send-status");
      expect(status).not.toBeNull();
      expect(status?.dataset.sendState).toBe(state);
      expect(status?.title).toBe("Delivery diagnostic");
      const reconnecting = state === "waiting-reconnect";
      const canDiscard =
        (state === "failed" || state === "unconfirmed" || reconnecting) && !actionLabel;
      expect(status?.textContent?.replace(/\s+/g, " ").trim()).toBe(
        `· ${label}${reconnecting ? "" : ` · ${actionLabel ?? "Retry"}`}${canDiscard ? " · Discard" : ""}`,
      );
      const retry = status?.querySelector<HTMLButtonElement>(".chat-send-status__retry");
      expect(retry?.getAttribute("aria-label")).toBe(
        reconnecting ? undefined : (actionLabel ?? "Retry queued message"),
      );
      retry?.click();
      if (reconnecting) {
        expect(onRetryQueuedMessage).not.toHaveBeenCalled();
      } else {
        expect(onRetryQueuedMessage).toHaveBeenCalledWith("attempted-send");
      }
      const discard = status?.querySelector<HTMLButtonElement>(".chat-send-status__discard");
      if (canDiscard) {
        expect(discard?.title).toBe(
          "Discard this local pending copy. This does not cancel a message already received by the Gateway.",
        );
        discard?.click();
        expect(onDiscardQueuedMessage).toHaveBeenCalledWith("attempted-send");
        discard?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
        expect(onDiscardQueuedMessage).toHaveBeenCalledTimes(1);
        expect(onRetryQueuedMessage).toHaveBeenCalledTimes(reconnecting ? 0 : 1);
      } else {
        expect(discard).toBeNull();
      }
    },
  );

  it("returns nothing when status is null", () => {
    const container = document.createElement("div");
    render(renderChatSendStatus(null, {}), container);
    expect(container.querySelector(".chat-send-status")).toBeNull();
  });
});
