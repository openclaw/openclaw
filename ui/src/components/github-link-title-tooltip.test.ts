/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { installTitleTooltips } from "./tooltip-title.ts";

const runtimeLoad = vi.hoisted(() => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
});
vi.mock(import("./github-link-hovercard.runtime.ts"), async (original) => {
  await runtimeLoad.pending;
  return original();
});

const tag = "openclaw-github-link-hovercard-provider";
const href = "https://github.com/openclaw/openclaw/issues/99815";
const response = {
  comments: 2,
  createdAt: "2026-07-05T08:00:00Z",
  kind: "issue",
  login: "octocat",
  number: 99815,
  owner: "openclaw",
  repo: "openclaw",
  state: "open",
  title: "Preview ready",
  updatedAt: "2026-07-05T09:55:00Z",
};
let dispose: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  dispose = installTitleTooltips(document);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("reserves supported GitHub titles through cold loading, failures, recovery and release", async () => {
  const first = createDeferred<unknown>();
  const second = createDeferred<unknown>();
  const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const provider = document.createElement(tag) as HTMLElement & { client: GatewayBrowserClient };
  provider.client = { request } as unknown as GatewayBrowserClient;
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.title = href;
  anchor.textContent = "#99815";
  provider.append(anchor);
  document.body.append(provider);
  const titleMounts: Node[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      titleMounts.push(
        ...[...record.addedNodes].filter(
          (node) => node instanceof Element && node.matches("openclaw-tooltip"),
        ),
      );
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const tooltip = () =>
    document.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>("openclaw-tooltip");
  const titleIsOpen = () =>
    Boolean(
      tooltip()?.shadowRoot?.querySelector<HTMLElement & { open: boolean }>("wa-tooltip")?.open,
    );
  const noPopupAria = () => {
    expect(anchor.hasAttribute("aria-haspopup")).toBe(false);
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
    expect(anchor.hasAttribute("aria-controls")).toBe(false);
  };
  try {
    // Install the real bootstrap after the title adapter: listener order must not matter.
    expect(customElements.get(tag)).toBeUndefined();
    await import("./github-link-hovercard-registration.ts");
    anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(customElements.get(tag)).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(anchor.title).toBe("");
    noPopupAria();
    expect({ mounts: titleMounts.length, open: titleIsOpen() }).toEqual({ mounts: 0, open: false });

    runtimeLoad.release();
    await import("./github-link-hovercard.runtime.ts");
    await customElements.whenDefined(tag);
    anchor.focus();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(titleMounts).toEqual([]);
    expect(document.querySelector(".github-link-hovercard")).toBeNull();
    noPopupAria();
    first.reject(new Error("Metadata unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    anchor.dispatchEvent(new MouseEvent("pointerleave", { composed: true }));
    anchor.blur();
    expect(anchor.title).toBe(href);
    anchor.focus();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(titleMounts).toEqual([]);
    noPopupAria();

    // An icon-only cached permalink still gets its name from title while native hints stay blank.
    const icon = document.createElement("a");
    icon.href = href + "#issuecomment-12";
    icon.title = "Issue details";
    provider.append(icon);
    icon.focus();
    expect(icon.title).toBe("");
    expect(icon.getAttribute("aria-label")).toBe("Issue details");
    icon.title = "Updated issue details";
    await vi.advanceTimersByTimeAsync(0);
    expect(icon.title).toBe("");
    expect(icon.getAttribute("aria-label")).toBe("Updated issue details");
    icon.blur();
    expect(icon.title).toBe("Updated issue details");
    expect(icon.hasAttribute("aria-label")).toBe(false);
    expect(icon.href).toBe(href + "#issuecomment-12");
    expect(titleMounts).toEqual([]);

    for (const [url, inside] of [
      ["https://example.com/item", true],
      ["https://github.com/openclaw/openclaw", true],
      [href, false],
    ] as const) {
      const control = document.createElement("a");
      control.href = url;
      control.title = "Ordinary title hint";
      control.textContent = "Ordinary link";
      (inside ? provider : document.body).append(control);
      control.focus();
      await vi.advanceTimersByTimeAsync(200);
      expect(titleIsOpen()).toBe(true);
      expect(tooltip()?.content).toBe("Ordinary title hint");
      control.blur();
      expect(control.title).toBe("Ordinary title hint");
      expect(control.href).toBe(url);
    }
    expect(request).toHaveBeenCalledTimes(1);
    const previousMounts = titleMounts.length;
    await vi.advanceTimersByTimeAsync(30_000);
    anchor.focus();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(titleMounts).toHaveLength(previousMounts);
    expect(titleIsOpen()).toBe(false);
    noPopupAria();
    second.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".github-link-hovercard")?.textContent).toContain(
      "Preview ready",
    );
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(titleMounts).toHaveLength(previousMounts);
    expect(anchor.title).toBe("");
    expect(anchor.href).toBe(href);
    anchor.blur();
    await vi.advanceTimersByTimeAsync(200);
    expect(anchor.title).toBe(href);
  } finally {
    runtimeLoad.release();
    await import("./github-link-hovercard.runtime.ts");
    await customElements.whenDefined(tag);
    first.resolve(response);
    second.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    observer.disconnect();
  }
});
