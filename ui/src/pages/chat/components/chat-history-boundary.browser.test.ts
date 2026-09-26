import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { renderChatHistoryBoundary } from "./chat-history-boundary.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("earlier history keyboard focus", () => {
  it("keeps focus through loading without reactivating or stealing focus after Tab", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const onShowEarlier = vi.fn();
    const update = (loading: boolean) =>
      render(
        html`${renderChatHistoryBoundary({ hasMore: true, loading, onShowEarlier })}
          <button type="button">Next action</button>`,
        container,
      );
    update(false);
    await userEvent.keyboard("{Tab}");
    const button = container.querySelector<HTMLButtonElement>(".chat-history-boundary__action")!;
    expect(document.activeElement).toBe(button);

    update(true);
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter} ");
    expect(onShowEarlier).not.toHaveBeenCalled();

    update(false);
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    expect(onShowEarlier).toHaveBeenCalledOnce();

    update(true);
    await userEvent.keyboard("{Tab}");
    const nextAction = container.querySelector<HTMLButtonElement>(":scope > button")!;
    expect(document.activeElement).toBe(nextAction);
    update(false);
    expect(document.activeElement).toBe(nextAction);
  });
});
