import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { MessageReactionPicker } from "./chat-message-reactions-view.tsx";
import "../../../styles/chat/grouped.css";

afterEach(cleanupSolid);

it("reveals the footer reaction trigger at the same opacity as its sibling actions", async () => {
  const view = mountSolid(() => (
    <div class="chat-group user" style={{ margin: "80px", width: "320px" }}>
      <div class="chat-group-footer-actions">
        <button class="chat-copy-btn" type="button" aria-label="Copy" />
        <MessageReactionPicker
          class="chat-reaction-action"
          activeEmoji={new Set()}
          placement="bottom-start"
          compact={false}
        />
      </div>
    </div>
  ));
  const copy = view.getByRole("button", { name: "Copy" });
  const picker = view.container.querySelector("openclaw-message-reaction-picker")!;
  const opacity = (element: Element) => getComputedStyle(element).opacity;
  await userEvent.hover(view.container.querySelector(".chat-group")!);
  await expect.poll(() => opacity(copy)).toBe("0.6");
  expect(opacity(picker)).toBe("0.6");
  await userEvent.hover(view.getByRole("button", { name: "Add reaction" }));
  await expect.poll(() => opacity(picker)).toBe("1");
});

it("keeps the hover-only picker usable when the pointer enters its native popup", async () => {
  const onSelect = vi.fn();
  const view = mountSolid(() => (
    <div class="chat-group" style={{ margin: "80px", width: "320px" }}>
      <MessageReactionPicker
        activeEmoji={new Set(["👍"])}
        placement="bottom-start"
        compact
        onSelect={onSelect}
      />
    </div>
  ));
  view.container
    .querySelector("openclaw-message-reaction-picker")!
    .classList.add("chat-reaction-chip--add");
  const trigger = view.getByRole("button", { name: "Add reaction" });
  await userEvent.hover(view.container.querySelector(".chat-group")!);
  await userEvent.click(trigger);
  const popup = view.container.querySelector<HTMLElement>(".chat-reaction-picker")!;
  await expect.poll(() => popup.dataset.phase).toBe("open");
  expect(document.activeElement).toBe(view.getByRole("button", { name: "👍" }));
  await userEvent.click(view.getByRole("button", { name: "More…" }));
  const input = view.getByRole("searchbox", { name: "Search emoji…" });
  await expect.poll(() => document.activeElement).toBe(input);
  const closingAnimation = popup.animate({ opacity: [1, 0] }, { duration: 200 });
  closingAnimation.pause();
  await userEvent.fill(input, "🦞");
  expect(onSelect).toHaveBeenCalledWith("🦞", false);
  await expect.poll(() => popup.dataset.phase).toBe("closing");
  expect(popup.classList.contains("custom")).toBe(true);
  expect(input).toHaveProperty("value", "🦞");
  closingAnimation.finish();
  await expect.poll(() => popup.dataset.phase).toBe("hidden");
  expect(document.activeElement).toBe(trigger);
  await userEvent.click(trigger);
  await expect.poll(() => popup.dataset.phase).toBe("open");
  expect(popup.classList.contains("custom")).toBe(false);
});
