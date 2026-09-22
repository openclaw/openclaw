/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
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

it("keeps rendered GitHub links free of native titles across preview closure and reentry", async () => {
  runtimeLoad.release();
  await import("./github-link-hovercard-registration.ts");
  const base = document.createElement("base");
  base.href = "https://dashboard.example/";
  document.body.append(base);
  const provider = document.createElement(tag) as HTMLElement & { client: GatewayBrowserClient };
  provider.client = createTestGatewayClient(async () => response);
  provider.innerHTML = toSanitizedMarkdownHtml(
    `${href}\n\n[the **related** issue](${href} "${href}")\n\n[![Issue icon](data:image/png;base64,x "Icon hint")](${href} "Issue details")\n\n[](${href} "Issue details")\n\n[<button>](${href} "Issue details")\n\n[\\*](${href} "Issue details")\n\n[Documentation](https://example.com "Read the documentation")`,
  );
  provider.innerHTML += toSanitizedMarkdownHtml(
    `[<button>](${href} "Issue details")\n\n[<progress title="Build status" value="1" max="2">50%</progress>](${href} "Issue details")\n\n[<progress aria-label="" title="Build status">Working</progress>](${href} "Issue details")\n\n[<progress aria-valuetext="" value="1"></progress>](${href} "Issue details")\n\n[<progress aria-hidden=" TRUE " value="1"></progress>](${href} "Issue details")\n\n[<progress value=""></progress>](${href} "Issue details")\n\n[<progress>Working</progress>](${href} "Issue details")\n\n[<progress aria-labelledby="missing"></progress>](${href} "Issue details")\n\n[Relative issue](${href.replace("https:", "")} "Issue details")`,
    { progressBars: true },
  );
  document.body.append(provider);
  const links = [...provider.querySelectorAll<HTMLAnchorElement>("a")].filter(
    (link) => link.href === href,
  );
  const noNativeTitles = () => {
    for (const link of links) {
      expect.soft(link.hasAttribute("title")).toBe(false);
      expect(link.querySelector("[title]")).toBeNull();
      expect(link.href).toBe(href);
      expect(link.target).toBe("_blank");
    }
  };
  expect(links).toHaveLength(15);
  expect.soft(links[13]?.getAttribute("aria-label")).toBe("Issue details");
  expect(links[14]?.getAttribute("href")).toBe(href.replace("https:", ""));
  noNativeTitles();
  const anchor = links[1]!;
  const child = anchor.querySelector("strong")!;
  const pointer = (target: Element, type: string, relatedTarget?: EventTarget) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, relatedTarget }));
  pointer(anchor, "pointerover");
  await customElements.whenDefined(tag);
  await vi.advanceTimersByTimeAsync(1_000);
  // The real lazy bootstrap requires browser :hover; focus supplies intent in jsdom.
  anchor.focus();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector(".github-link-hovercard")?.textContent).toContain("Preview ready");
  noNativeTitles();
  pointer(anchor, "pointerout", child);
  pointer(child, "pointerover", anchor);
  await vi.advanceTimersByTimeAsync(200);
  expect(document.querySelector(".github-link-hovercard")).not.toBeNull();
  anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.advanceTimersByTimeAsync(200);
  expect(document.querySelector(".github-link-hovercard")).toBeNull();
  noNativeTitles();
  pointer(child, "pointerout", document.body);
  pointer(anchor, "pointerleave", document.body);
  anchor.blur();
  await vi.advanceTimersByTimeAsync(200);
  noNativeTitles();
  pointer(child, "pointerover", document.body);
  await vi.advanceTimersByTimeAsync(300);
  expect(document.querySelector(".github-link-hovercard")).not.toBeNull();
  noNativeTitles();
  expect(links[0]?.textContent).toBe("#99815");
  expect(anchor.textContent).toBe("the related issue");
  expect(links[2]?.querySelector("img")?.alt).toBe("Issue icon");
  expect(links[3]?.getAttribute("aria-label")).toBe("Issue details");
  expect(links[4]?.textContent).toBe("<button>");
  expect(links[4]?.hasAttribute("aria-label")).toBe(false);
  expect(links[5]?.textContent).toBe("*");
  expect.soft(links[5]?.hasAttribute("aria-label")).toBe(false);
  expect(links[6]?.textContent).toBe("");
  expect(links[6]?.getAttribute("aria-label")).toBe("Issue details");
  expect(links[7]?.querySelector("progress")?.value).toBe(1);
  expect(links[7]?.querySelector("progress")?.getAttribute("aria-label")).toBe("Build status");
  expect.soft(links[7]?.hasAttribute("aria-label")).toBe(false);
  expect(links[8]?.hasAttribute("aria-label")).toBe(false);
  expect.soft(links[8]?.querySelector("progress")?.getAttribute("aria-label")).toBe("Build status");
  expect.soft(links[9]?.getAttribute("aria-label")).toBe("Issue details");
  expect(links[10]?.getAttribute("aria-label")).toBe("Issue details");
  expect(links[11]?.hasAttribute("aria-label")).toBe(false);
  expect(links[12]?.getAttribute("aria-label")).toBe("Issue details");
  const ordinary = provider.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')!;
  pointer(child, "pointerout", ordinary);
  pointer(anchor, "pointerleave", ordinary);
  ordinary.focus();
  await vi.advanceTimersByTimeAsync(200);
  const tooltip =
    document.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>("openclaw-tooltip");
  expect(tooltip?.content).toBe("Read the documentation");
  expect(
    tooltip?.shadowRoot?.querySelector<HTMLElement & { open: boolean }>("wa-tooltip")?.open,
  ).toBe(true);
  ordinary.blur();
  expect(ordinary.title).toBe("Read the documentation");
});
