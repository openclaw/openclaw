/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  activityHello,
  activityResponse,
  activityRoster,
  createActivityPageHarness,
  expandFirst,
  previews,
  toolEvent,
} from "./activity-page.test-support.ts";

const { activityGateway, bindActivity, cleanup } = createActivityPageHarness();

afterEach(cleanup);

function clickLiveAction(container: HTMLElement, label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(".activity-live-actions__trigger");
  trigger?.click();
  flush();
  expect(trigger?.getAttribute("aria-expanded")).toBe("true");
  const item = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (button) => button.textContent?.trim() === label,
  );
  expect(item?.textContent?.trim()).toBe(label);
  item?.click();
  flush();
}

describe("ActivityPage toolbar and filters", () => {
  it("keeps primary live filters visible and moves the tool picker into the filter disclosure", async () => {
    await i18n.setLocale("en");
    const { gateway: source, current } = activityGateway();
    const { container } = await bindActivity(source, "/control");
    current().testOptions.onEvent?.(toolEvent("Mu\u0308nchen", "main", "exec", "live run:a/b"));
    current().testOptions.onEvent?.(toolEvent("Caf\u00e9"));
    const toolbar = container.querySelector(".activity-live-toolbar");
    expect(toolbar?.querySelectorAll("button.activity-status-filter[aria-pressed]")).toHaveLength(
      3,
    );
    expect(
      toolbar?.querySelector(".activity-live-autofollow input.settings-toggle__input"),
    ).not.toBeNull();
    const filterTrigger = toolbar?.querySelector<HTMLButtonElement>(
      "#activity-live-filter-trigger",
    );
    expect(filterTrigger?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(filterTrigger?.getAttribute("aria-expanded")).toBe("false");
    await waitForSolid(() =>
      expect(container.querySelector(".activity-entry__run-link")?.getAttribute("href")).toBe(
        "/control/activity?view=run&run=live%20run%3Aa%2Fb",
      ),
    );
    filterTrigger?.click();
    expect(document.activeElement).toBe(container.querySelector(".activity-live-filter-popover"));

    const done = toolbar?.querySelectorAll<HTMLButtonElement>(
      "button.activity-status-filter[aria-pressed]",
    )[1];
    done?.click();
    flush();
    expect(done?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(0);
    done?.click();
    flush();
    expect(done?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(2);

    const follow = toolbar?.querySelector<HTMLInputElement>(
      ".activity-live-autofollow input.settings-toggle__input",
    );
    follow?.click();
    flush();
    expect(follow?.checked).toBe(false);
    follow?.click();
    flush();
    expect(follow?.checked).toBe(true);

    const expansionState = () =>
      Array.from(
        container.querySelectorAll<HTMLDetailsElement>(".activity-entry"),
        (row) => row.open,
      );
    clickLiveAction(container, "Expand all");
    expect(expansionState()).toEqual([true, true]);
    clickLiveAction(container, "Collapse all");
    expect(expansionState()).toEqual([false, false]);

    toolbar
      ?.querySelector<HTMLButtonElement>(".activity-live-search .header-search__toggle")
      ?.click();
    flush();
    const search = toolbar?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) {
      throw new Error("Expected the live activity search input");
    }
    search.value = "no matching activity";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(0);
    search.value = "m\u00fcnchen";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(1);
    expect(container.textContent).toContain("Mu\u0308nchen output");
    search.value = "cafe\u0301";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(1);

    const tool = container.querySelector<HTMLSelectElement>(".activity-live-filter-popover select");
    if (!tool) {
      throw new Error("Expected the live activity tool filter");
    }
    tool.value = "read";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(
      Array.from(container.querySelectorAll(".activity-entry__tool"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["read"]);
  });

  it("retains the selected tool when Live entries change", async () => {
    await i18n.setLocale("en");
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().testOptions.onEvent?.(toolEvent("exec", "main", "exec"));
    current().testOptions.onEvent?.(toolEvent("read"));
    await waitForSolid(() => expect(previews(page)).toEqual(["exec output", "read output"]));
    const container = page.container;
    const tool = container.querySelector<HTMLSelectElement>(".activity-live-filter-popover select");
    if (!tool) {
      throw new Error("Expected the live activity tool filter");
    }
    tool.value = "read";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(tool?.value).toBe("read");
    expect(tool?.selectedOptions[0]?.textContent).toBe("read");
    expect(
      Array.from(container.querySelectorAll(".activity-entry__tool"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["read"]);

    clickLiveAction(container, "Clear");
    current().testOptions.onEvent?.(toolEvent("read"));
    await waitForSolid(() => expect(previews(page)).toEqual(["read output"]));
    expect(tool?.value).toBe("read");
    expect(tool?.selectedOptions[0]?.textContent).toBe("read");
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(1);

    current().testOptions.onEvent?.(toolEvent("exec", "main", "exec"));
    tool.value = "";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForSolid(() => expect(previews(page)).toEqual(["read output", "exec output"]));
    expect(tool?.value).toBe("");
    expect(tool?.selectedOptions[0]?.textContent).toBe("All tools");
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(2);
  });

  it("retains Current Work and local filters while the same client reconnects", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    page.container
      .querySelector<HTMLButtonElement>(".activity-live-search .header-search__toggle")
      ?.click();
    flush();
    const filter = page.container.querySelector<HTMLInputElement>(
      ".activity-live-search input[type=search]",
    )!;
    filter.value = "my draft filter";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    const rows = () => page.container.querySelectorAll(".activity-current-work__row");
    expect(rows()).toHaveLength(2);
    const firstRow = rows()[0];
    const currentWork = () => page.container.querySelector(".activity-current-work");

    current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(rows()).toHaveLength(2);
    expect(filter.value).toBe("my draft filter");

    const failed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? failed.promise : activityResponse(method, params),
    );
    current().testOptions.onHello?.(activityHello());
    flush();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toBe(firstRow);
    expect(currentWork()?.getAttribute("aria-busy")).toBe("true");
    expect(filter.value).toBe("my draft filter");
    failed.reject(new Error("Current Work refresh unavailable"));
    const retry = () =>
      page.container.querySelector<HTMLButtonElement>(".activity-current-work__feedback button");
    await waitForSolid(() => expect(retry()?.textContent?.trim()).toBe("Retry"));
    expect(page.container.querySelector(".activity-current-work__feedback")?.textContent).toContain(
      "Couldn’t load active sessions. Try again.",
    );
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toBe(firstRow);
    expect(currentWork()?.getAttribute("aria-busy")).toBe("false");
    const refreshed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? refreshed.promise : activityResponse(method, params),
    );
    retry()!.click();
    flush();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toBe(firstRow);
    expect(currentWork()?.getAttribute("aria-busy")).toBe("true");
    refreshed.resolve(activityRoster([]));
    await waitForSolid(() => expect(rows()).toHaveLength(0));
    expect(retry()).toBeNull();
    expect(filter.value).toBe("my draft filter");
  });

  it("preserves activity and Clear when the selected chat changes", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().testOptions.onEvent?.(toolEvent("original"));
    const originalRow = await expandFirst(page);
    source.setSessionKey("agent:other:work");

    await waitForSolid(() => expect(previews(page)).toEqual(["original output"]));
    expect(originalRow.open).toBe(true);
    expect(page.container.querySelector(".activity-entry")).toBe(originalRow);
    current().testOptions.onEvent?.(toolEvent("other", "agent:other:work"));
    await waitForSolid(() => expect(previews(page)).toEqual(["original output", "other output"]));

    const container = page.container;
    clickLiveAction(container, "Clear");
    source.setSessionKey("main");
    await waitForSolid(() => expect(previews(page)).toEqual([]));
    current().testOptions.onEvent?.(toolEvent("after-clear", "agent:other:work"));
    await waitForSolid(() => expect(previews(page)).toEqual(["after-clear output"]));
  });
});
