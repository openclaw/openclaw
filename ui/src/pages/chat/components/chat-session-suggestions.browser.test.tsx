import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { SessionSuggestion } from "../../../../../packages/gateway-protocol/src/index.js";
import { i18n } from "../../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatSessionSuggestions } from "./chat-session-suggestions.solid.tsx";
import "../../../styles.css";
import "../../../styles/chat.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
  document.documentElement.dataset.themeMode = "dark";
});
afterEach(() => {
  cleanupSolid();
  delete document.documentElement.dataset.themeMode;
});
const suggestions: SessionSuggestion[] = ["Alice", "Blair", "Casey", "Drew", "Eden"].map(
  (name, index) => ({
    id: `suggestion-${index}`,
    sessionKey: "agent:main:synthetic-suggestions",
    agentId: "main",
    author: { type: "human", id: name.toLowerCase(), label: name },
    createdAt: index + 1,
    state: "pending",
    text: `${name}'s proposal: simplify the next release checklist.\nKeep the existing review and approval steps.\nCheck the desktop and mobile views before publishing.`,
  }),
);

it.each([390, 900])(
  "keeps suggestions compact, expandable, keyboard accessible and actionable at %s px",
  async (width) => {
    await page.viewport(width, 600);
    const onResolve = vi.fn();
    const view = mountSolid(() => (
      <div style={{ padding: "20px", "max-width": "860px" }}>
        <ChatSessionSuggestions
          suggestions={suggestions}
          role="owner"
          busyIds={new Set()}
          archived={false}
          canResolve
          onResolve={onResolve}
        />
        <textarea
          aria-label="Message"
          placeholder="Message"
          style={{ width: "100%", "margin-top": "8px", "min-height": "80px" }}
        />
      </div>
    ));
    const rows = () => view.container.querySelectorAll<HTMLElement>(".session-suggestion");
    expect(rows()).toHaveLength(3);
    const first = rows()[0]!;
    const details = first.querySelector("details")!;
    const summary = first.querySelector("summary")!;
    const action = first.querySelector<HTMLElement>(".session-suggestion__action")!;
    await userEvent.hover(page.getByRole("textbox", { name: "Message" }));
    expect(first.getBoundingClientRect().height).toBeLessThanOrEqual(34);
    expect(getComputedStyle(action).opacity).toBe("0");
    expect(view.container.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.artifacts/participate-suggestions/${width}-after.png` });
    summary.focus();
    await expect.poll(() => getComputedStyle(action).opacity).toBe("1");
    await userEvent.keyboard("{Enter}");
    expect(details.open).toBe(true);
    expect(
      first.querySelector(".session-suggestion__body")!.getBoundingClientRect().height,
    ).toBeGreaterThan(32);
    await page.screenshot({ path: `.artifacts/participate-suggestions/${width}-expanded.png` });
    await userEvent.keyboard("{Enter}");
    expect(details.open).toBe(false);
    await userEvent.hover(page.elementLocator(first));
    expect(getComputedStyle(action).opacity).toBe("1");
    await userEvent.click(page.getByRole("button", { name: "Send Alice's suggestion now" }));
    expect(onResolve).toHaveBeenCalledExactlyOnceWith(suggestions[0], "send");
    expect(details.open).toBe(false);
    await userEvent.click(page.getByRole("button", { name: "+2 more", exact: true }));
    expect(rows()).toHaveLength(5);
    await userEvent.click(page.getByRole("button", { name: "Show less", exact: true }));
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toBe(first);
  },
);
