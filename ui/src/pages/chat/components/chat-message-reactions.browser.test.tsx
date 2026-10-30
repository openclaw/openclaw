import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import "../../../styles/base.css";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { MessageReactionPicker } from "./chat-message-reactions-view.tsx";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import "../../../styles/chat/grouped.css";
import "../../../styles/chat/layout.css";

afterEach(cleanupSolid);

it("keeps the reaction picker beside its message after a virtualized transcript scroll", async () => {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1000, 800);
  const viewport = document.body.appendChild(document.createElement("div"));
  viewport.style.cssText =
    "position:relative;height:500px;width:800px;overflow:auto;margin:80px 24px";
  const rows = Array.from({ length: 40 }, (_, index) => {
    const content = document.createElement("div");
    content.style.cssText = "height:80px;box-sizing:border-box;padding:8px 24px";
    content.textContent = `Synthetic row ${index + 1}`;
    return { kind: "content" as const, key: `row:${index}`, content };
  });
  const pickerHost = rows[8]!.content.appendChild(document.createElement("div"));
  const onSelect = vi.fn();
  const picker = mountSolid(
    () => (
      <MessageReactionPicker activeEmoji={new Set()} placement="bottom-start" onSelect={onSelect} />
    ),
    { container: pickerHost },
  );
  const session = new ChatSessionVirtualizerHost(() => queueMicrotask(paint), 400);
  session.layout.ready = true;
  function paint() {
    if (!session.connected) {
      return;
    }
    const element = session.render(
      rows,
      (row) => (row.kind === "content" ? row.content : null),
      null,
      false,
    );
    if (element.parentElement !== viewport) {
      viewport.append(element);
    }
    session.update();
  }
  try {
    session.connect();
    paint();
    await expect.poll(() => session.isPositionSettled).toBe(true);
    const firstIndex = () =>
      Number(viewport.querySelector(".chat-virtual-row")?.getAttribute("data-index"));
    await expect.poll(firstIndex).toBeGreaterThan(0);
    const trigger = picker.getByRole("button", { name: "Add reaction" });
    const openPicker = async () => {
      await userEvent.click(trigger);
      const popup = picker.container.querySelector<HTMLElement>(".chat-reaction-picker")!;
      await expect.poll(() => popup.dataset.phase).toBe("open");
      await expect
        .poll(() =>
          Math.abs(popup.getBoundingClientRect().top - trigger.getBoundingClientRect().bottom - 6),
        )
        .toBeLessThan(1);
    };
    await openPicker();
    await userEvent.click(picker.getByRole("button", { name: "👍" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("👍", false);
    const beforeScroll = firstIndex();
    viewport.scrollTop += 80;
    await expect.poll(firstIndex).toBeGreaterThan(beforeScroll);
    await openPicker();
  } finally {
    session.dispose();
    picker.unmount();
    viewport.remove();
    await page.viewport(previousViewport.width, previousViewport.height);
  }
});

it.each([320, 800])(
  "keeps the hover-only picker usable without horizontal overflow at %ipx",
  async (width) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    onTestFinished(() => page.viewport(viewport.width, viewport.height));
    await page.viewport(width, 640);
    const onSelect = vi.fn();
    const view = mountSolid(() => (
      <div class="chat-message-reactions" style={{ margin: "24px", width: "272px" }}>
        <MessageReactionPicker
          class="chat-reaction-chip chat-reaction-chip--add"
          activeEmoji={new Set(["👍"])}
          placement="bottom-start"
          compact
          onSelect={onSelect}
        />
      </div>
    ));
    const trigger = view.getByRole("button", { name: "Add reaction" });
    await userEvent.hover(view.container.querySelector(".chat-message-reactions")!);
    await userEvent.click(trigger);
    const popup = view.container.querySelector<HTMLElement>(".chat-reaction-picker")!;
    await expect.poll(() => popup.dataset.phase).toBe("open");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "👍" }));
    await userEvent.click(view.getByRole("button", { name: "More…" }));
    await expect
      .poll(() => view.queryByRole("searchbox", { name: "Search emoji…" }))
      .not.toBeNull();
    const input = view.getByRole("searchbox", { name: "Search emoji…" });
    await expect.poll(() => document.activeElement).toBe(input);
    expect(popup.scrollWidth).toBe(popup.clientWidth);
    expect(input.getBoundingClientRect().right).toBeLessThanOrEqual(
      popup.getBoundingClientRect().right,
    );
    await userEvent.fill(input, "a");
    const grid = view.container.querySelector<HTMLElement>(".emoji-search-panel__grid")!;
    await expect.poll(() => grid.scrollHeight).toBeGreaterThan(grid.clientHeight);
    expect(grid.scrollWidth).toBe(grid.clientWidth);
    expect(popup.scrollWidth).toBe(popup.clientWidth);
    grid.scrollTop = grid.scrollHeight;
    expect(grid.scrollTop).toBeGreaterThan(0);
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
  },
);
