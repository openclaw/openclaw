/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { MarkdownDomReconciler } from "../lib/markdown-dom-reconciler.ts";
import { renderSolidRef } from "../test-helpers/render-solid-ref.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";
import "./session-progress-hovercard-registration.ts";
import { SESSION_TITLE_TARGET_SELECTOR } from "./session-progress-hovercard-target.ts";
import { registerSessionTitleTarget } from "./session-title-target-registration.ts";

const SESSION_KEY = "agent:main:research";
const DASHBOARD_KEY = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
function row(displayName?: string, key = SESSION_KEY): GatewaySessionRow {
  return { key, kind: "direct", displayName, updatedAt: Date.now() };
}
function registerTargets(titler: SessionLinkTitler, host: HTMLElement) {
  for (const target of host.querySelectorAll<HTMLElement>(SESSION_TITLE_TARGET_SELECTOR)) {
    titler.register(
      target,
      target.querySelector<HTMLElement>(".session-label") ?? document.createElement("span"),
    );
  }
}

function decorate(titler: SessionLinkTitler, element: HTMLElement) {
  titler.register(
    element,
    element.querySelector<HTMLElement>(".session-label") ?? document.createElement("span"),
  );
  return titler.decorate(element);
}

function renderMarkdown(
  titler: SessionLinkTitler,
  host: HTMLElement,
  value: string,
  fileLinks = false,
) {
  host.innerHTML = toSanitizedMarkdownHtml(value, { sessionLinks: true, fileLinks });
  registerTargets(titler, host);
  return () => host.querySelector<HTMLAnchorElement>("a.markdown-session-link")!;
}
function observe(host: HTMLElement) {
  const observer = new MutationObserver(() => undefined);
  observer.observe(host, { attributes: true, childList: true, subtree: true });
  return observer;
}
function expectTitle(element: Element, title: string) {
  expect(element).toMatchObject({ textContent: title });
  expect(element.querySelectorAll(":scope > .session-label")).toHaveLength(1);
  expect(element.querySelector(".session-label")?.textContent).toBe(title);
}
function expectAttributes(element: Element, attributes: Record<string, string | null>) {
  expect(
    Object.fromEntries(Object.keys(attributes).map((key) => [key, element.getAttribute(key)])),
  ).toEqual(attributes);
}
async function refresh(titler: SessionLinkTitler) {
  titler.refresh();
  await vi.runAllTimersAsync();
}

function sessionContext(rows: GatewaySessionRow[] = [], origin?: string): ApplicationContext {
  return {
    basePath: "",
    ...(origin
      ? {
          runtimeConfig: {
            state: { configSnapshot: { runtimeConfig: { gateway: { publicOrigin: origin } } } },
          },
        }
      : {}),
    sessions: {
      state: { result: { count: rows.length, sessions: rows } },
      subscribe: () => () => undefined,
    },
    agentSelection: { subscribe: () => () => undefined },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: {
      connectionRevision: 0,
      snapshot: { hello: null, phase: "connected", selfUser: { id: "first-profile" } },
    },
  } as unknown as ApplicationContext;
}

function sessionAnchor(sessionKey = SESSION_KEY): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "markdown-session-link";
  anchor.dataset.sessionKey = sessionKey;
  anchor.textContent = sessionKey;
  return anchor;
}

function previewResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    sessionKey: SESSION_KEY,
    title: "Research plan",
    agentId: "main",
    ...overrides,
  };
}

function createTitler(rows: GatewaySessionRow[] = [], request = vi.fn()) {
  const host = document.createElement("div");
  const titler = new SessionLinkTitler();
  titler.client = { request } as unknown as GatewayBrowserClient;
  titler.context = sessionContext(rows);
  return { host, request, titler };
}

describe("SessionLinkTitler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("seeds and updates roster titles without turning labels into navigation", async () => {
    const { host, request, titler } = createTitler([row("Cached research")]);
    const label = document.createElement("span");
    label.dataset.sessionTitleOnly = "";
    label.dataset.sessionKey = SESSION_KEY;
    label.innerHTML = '<span class="session-label"></span>';
    host.append(label);
    registerTargets(titler, host);
    titler.refresh();
    expectTitle(label, "Cached research");
    expect(label.classList.contains("markdown-session-link--titled")).toBe(true);
    expectAttributes(label, { title: null, href: null });
    expect(label.parentElement).toBe(host);
    expect(label.matches("a, [href], [tabindex], .markdown-session-link")).toBe(false);
    expect(request).not.toHaveBeenCalled();
    titler.context = sessionContext([row("Current research")]);
    await decorate(titler, label);
    expectTitle(label, "Current research");
    expect(label.matches("a, [href], [tabindex], .markdown-session-link")).toBe(false);
  });

  it("caches titles and retains producer labels", async () => {
    const request = vi.fn().mockResolvedValue(previewResponse());
    const { titler } = createTitler([], request);
    const first = sessionAnchor();
    const second = sessionAnchor();
    const label = document.createElement("span");
    label.className = "session-label";
    label.textContent = SESSION_KEY;
    first.replaceChildren(label);

    await decorate(titler, first);
    await decorate(titler, second);

    expectTitle(first, "Research plan");
    expectTitle(second, "Research plan");
    await decorate(titler, first);
    expectTitle(first, "Research plan");
    expect(first.getAttribute("href")).toBe("/chat/main/research");
    expect(request).toHaveBeenCalledExactlyOnceWith("controlUi.sessionPreview", {
      sessionKey: SESSION_KEY,
    });
    expect(first.firstElementChild).toBe(label);
    label.textContent = "Updated by the producer";
    expect(first.textContent).toBe("Updated by the producer");
    titler.context = sessionContext([row("Replacement Gateway")]);
    await decorate(titler, first);
    expect(first.firstElementChild).toBe(label);
    expect(first.textContent).toBe("Updated by the producer");
  });

  it.each(
    ["cached", "pending"].flatMap((state) =>
      ["replacement", "reconnect", "profile", "client ABA"].map((change) => ({ state, change })),
    ),
  )("retires $state titles after $change", async ({ state, change }) => {
    const oldPreview = Promise.withResolvers<ReturnType<typeof previewResponse>>();
    const request = vi.fn().mockImplementation(() => oldPreview.promise);
    const { titler } = createTitler([], request);
    const previous = sessionAnchor();
    const decorating = decorate(titler, previous);
    await Promise.resolve();
    if (state === "cached") {
      oldPreview.resolve(previewResponse({ title: "Previous Gateway" }));
      await decorating;
    }
    request.mockResolvedValue(previewResponse({ title: "Current Gateway" }));
    if (change === "replacement") {
      const replacement = createTitler([], request);
      titler.client = replacement.titler.client;
      titler.context = replacement.titler.context;
    } else if (change === "reconnect") {
      Object.assign(titler.context!.gateway, { connectionRevision: 1 });
    } else if (change === "profile") {
      Object.assign(titler.context!.gateway.snapshot, { selfUser: { id: "next-profile" } });
    } else {
      const client = titler.client;
      titler.client = null;
      titler.client = client;
    }
    oldPreview.resolve(previewResponse({ title: "Previous Gateway" }));
    await decorating;
    expect(previous.textContent).toBe(state === "cached" ? "Previous Gateway" : SESSION_KEY);
    const current = state === "cached" ? previous : sessionAnchor();
    await decorate(titler, current);

    expect(current.textContent).toBe("Current Gateway");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("expires successful and failed cache entries at their separate TTLs", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(previewResponse({ title: undefined }))
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockResolvedValueOnce(previewResponse());
    const { titler } = createTitler([], request);

    await decorate(titler, sessionAnchor());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await decorate(titler, sessionAnchor());
    await decorate(titler, sessionAnchor());
    expect(request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await decorate(titler, sessionAnchor());
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("keeps unresolved URLs navigable (retired title: %s)", async (retired) => {
    const key = DASHBOARD_KEY;
    const request = vi.fn().mockResolvedValue({
      ok: false,
      candidates: [key, key.replace("3211", "4322")].map((candidate) => ({
        key: candidate,
        agentId: "main",
      })),
    });
    const { host, titler } = createTitler(retired ? [row("Previous Gateway", key)] : [], request);
    const href = "/chat/main/d0effac9?view=details#latest";
    const link = renderMarkdown(titler, host, `[Plan](${href})`)();
    if (retired) {
      await decorate(titler, link);
      expect(link.textContent).toBe("Previous Gateway");
      titler.context = sessionContext();
    }
    const label = link.firstElementChild;
    await refresh(titler);
    await refresh(titler);
    expect(link.textContent).toBe(retired ? key : "Plan");
    expect(link.firstElementChild).toBe(label);
    expect(link.classList.contains("markdown-session-link--titled")).toBe(false);
    expectAttributes(link, { title: null, "data-session-key": null, href });
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.resolve", {
      shortId: "d0effac9",
      agentId: "main",
      allowMissing: true,
    });
  });

  it.each([true, false])("titles unloaded URLs (full key: %s)", async (fullKey) => {
    const displayName = fullKey ? "Peter's plan" : undefined;
    const source = fullKey
      ? "`https://chat.example/chat/main/dashboard/d0effac9-3211-4641-b993-10f619f124e6`"
      : "[Plan](/chat/main/d0effac9?view=details)";
    const params = fullKey
      ? {
          reference: { key: DASHBOARD_KEY },
          agentId: "main",
          includeGlobal: true,
          includeUnknown: true,
          allowMissing: true,
        }
      : { shortId: "d0effac9", agentId: "main", allowMissing: true };
    const key = DASHBOARD_KEY;
    const request = vi.fn(async (method: string) =>
      method === "sessions.resolve"
        ? { ok: true, key, agentId: "main", ...(displayName ? { displayName } : {}) }
        : previewResponse({ sessionKey: key, title: undefined, derivedTitle: "Derived plan" }),
    );
    const { host, titler } = createTitler([], request);
    titler.context = sessionContext([], "https://chat.example");
    const getLink = renderMarkdown(titler, host, source);
    await refresh(titler);
    const link = getLink();

    expect(link).toMatchObject({
      textContent: displayName ?? "Derived plan",
      dataset: { sessionKey: key },
    });
    expect(link.hasAttribute("title")).toBe(false);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.resolve", params);
    expect(request).toHaveBeenCalledTimes(displayName ? 1 : 2);

    const observer = observe(host);
    await refresh(titler);
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    expect(request).toHaveBeenCalledTimes(displayName ? 1 : 2);
  });

  it.each([
    ["bare URL", `${location.origin}/chat/main/d0effac9?view=details#latest`],
    ["relative href", "[Contract](/chat/main/old-name-d0effac9?view=details#latest)"],
    ["titled short href", "[Contract](/chat/main/shared-contract-d0effac9?view=details#latest)"],
    ["slug-only href", "[Contract](/chat/main/shared-contract?view=details#latest)"],
    ["inline code", "`/chat/main/d0effac9?view=details#latest`"],
    ["public URL", "https://chat.example/chat/main/d0effac9?view=details#latest"],
    ["public inline code", "`https://chat.example/chat/main/d0effac9?view=details#latest`"],
  ])("preserves hover identity and route intent for %s", async (_kind, markdown) => {
    const key = DASHBOARD_KEY;
    const session = row("Shared contract", key);
    const rows: GatewaySessionRow[] = [session];
    const { host, titler, request } = createTitler(rows);
    titler.context = sessionContext(rows, "https://CHAT.example:443/");
    host.innerHTML = toSanitizedMarkdownHtml(markdown, { sessionLinks: true, fileLinks: true });
    registerTargets(titler, host);
    titler.refresh();
    await Promise.resolve();
    const link = host.querySelector<HTMLAnchorElement>("a.markdown-session-link")!;
    expect(link).toMatchObject({ dataset: { sessionKey: key }, textContent: "Shared contract" });
    expectAttributes(link, { title: null, target: null });
    expect(link.getAttribute("href")).toMatch(
      /^\/chat\/main\/(?:.*d0effac9|shared-contract)\?view=details#latest$/,
    );
    expect(request).not.toHaveBeenCalled();
    titler.disconnect();
  });

  it("reconciles roster changes without redundant mutations", () => {
    const key = DASHBOARD_KEY;
    const rows: GatewaySessionRow[] = [];
    const { host, titler, request } = createTitler(rows, vi.fn().mockResolvedValue({ ok: false }));
    const hrefs = ["d0effac9?view=details#first", "d0effac9?view=details#second", "aabbccdd"].map(
      (path) => `/chat/main/${path}`,
    );
    host.innerHTML = toSanitizedMarkdownHtml(
      hrefs.map((href, index) => `[Link ${index}](${href})`).join(" ") +
        " " +
        "[Remote](https://elsewhere.example/chat/main/d0effac9) `https://elsewhere.example/chat/main/d0effac9`",
      { sessionLinks: true },
    );
    registerTargets(titler, host);
    titler.refresh();
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a.markdown-session-link")];
    const keys = () => links.map((link) => link.dataset.sessionKey);
    const unresolved = [undefined, undefined, undefined];
    expect(keys()).toEqual(unresolved);
    expect(links[0]?.getAttribute("href")).toBe(hrefs[0]);
    rows.push(row("Shared contract", key));
    titler.refresh();
    expect(keys()).toEqual([key, key, undefined]);
    const observer = observe(host);
    try {
      rows[0] = { ...rows[0]!, updatedAt: Date.now() + 1 };
      titler.refresh();
      expect(observer.takeRecords()).toEqual([]);
      expect(links.map((link) => link.getAttribute("href"))).toEqual(hrefs);

      rows.push({ key: key.replace("3211", "4322"), kind: "direct", updatedAt: Date.now() });
      titler.refresh();
      expect(keys()).toEqual(unresolved);
      observer.takeRecords();
      titler.refresh();
      expect(observer.takeRecords()).toEqual([]);

      rows.pop();
      titler.refresh();
      expect(keys()).toEqual([key, key, undefined]);
      expect(host.querySelectorAll("a:not(.markdown-session-link)")).toHaveLength(1);
      expect(host.querySelector<HTMLAnchorElement>("a:not(.markdown-session-link)")?.target).toBe(
        "_blank",
      );
      expect(host.querySelector("code")?.parentElement?.tagName).not.toBe("A");
      // Roster-resolved links never need a title request.
      expect(request).not.toHaveBeenCalledWith("controlUi.sessionPreview", expect.anything());
    } finally {
      observer.disconnect();
    }
  });
});

describe("producer-owned session titles", () => {
  it("titles late Markdown links across provider remounts and retires a removed pending target", async ({
    onTestFinished,
  }) => {
    const preview = Promise.withResolvers<ReturnType<typeof previewResponse>>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.resolve") {
        return Promise.resolve({
          ok: true,
          key: DASHBOARD_KEY,
          agentId: "main",
          displayName: "Shared contract",
        });
      }
      if (method === "controlUi.sessionPreview") {
        return preview.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const provider = Object.assign(
      document.createElement("openclaw-session-progress-hovercard-provider"),
      { client: { request }, context: sessionContext() },
    );
    const mountPoint = provider.appendChild(document.createElement("div"));
    const host = document.createElement("div");
    document.body.append(provider);
    const [content, setContent] = createSignal("");
    const view = renderSolidRef(
      () => createMarkdownRef(() => ({ content: content(), incremental: true })),
      { container: mountPoint, targetElement: host },
    );
    onTestFinished(() => {
      view.unmount();
      provider.remove();
    });
    const first = toSanitizedMarkdownHtml("[Plan](/chat/main/d0effac9?view=details#latest)", {
      sessionLinks: true,
    });
    const second = toSanitizedMarkdownHtml(SESSION_KEY, { sessionLinks: true });
    setContent(first);
    await waitForSolid(() => expect(host.querySelector("a")).not.toBeNull());
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(host.textContent?.trim()).toBe("Shared contract"));
    const firstLink = host.querySelector<HTMLAnchorElement>("a")!;
    expect(firstLink.getAttribute("href")).toBe("/chat/main/d0effac9?view=details#latest");

    provider.remove();
    await Promise.resolve();
    provider.context = sessionContext([row("Reconnected plan", DASHBOARD_KEY)]);
    document.body.append(provider);
    await vi.waitFor(() => expect(firstLink.textContent).toBe("Reconnected plan"));
    expect(host.querySelector("a")).toBe(firstLink);

    setContent(first + second);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("controlUi.sessionPreview", { sessionKey: SESSION_KEY }),
    );
    const removed = host.querySelector<HTMLAnchorElement>(`a[data-session-key="${SESSION_KEY}"]`)!;
    setContent(first);
    await waitForSolid(() => expect(removed.isConnected).toBe(false));
    preview.resolve(previewResponse());
    setContent(first + second);
    await vi.waitFor(() =>
      expect(host.querySelector(`a[data-session-key="${SESSION_KEY}"]`)?.textContent).toBe(
        "Research plan",
      ),
    );
    expect(host.querySelector("a")).toBe(firstLink);
    expect(removed.textContent).toBe(SESSION_KEY);
    expect(removed.classList.contains("markdown-session-link--titled")).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("releases a Markdown target before its lazy registration starts", async ({
    onTestFinished,
  }) => {
    const request = vi.fn();
    const provider = Object.assign(
      document.createElement("openclaw-session-progress-hovercard-provider"),
      { client: { request }, context: sessionContext() },
    );
    const host = provider.appendChild(document.createElement("div"));
    document.body.append(provider);
    onTestFinished(() => provider.remove());
    const markdown = new MarkdownDomReconciler(host, registerSessionTitleTarget);
    markdown.updateHtml(toSanitizedMarkdownHtml(SESSION_KEY, { sessionLinks: true }));
    markdown.dispose();
    await vi.dynamicImportSettled();
    expect(request).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
});
