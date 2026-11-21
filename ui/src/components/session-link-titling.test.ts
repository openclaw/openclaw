/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { MarkdownDomReconciler } from "../lib/markdown-dom-reconciler.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { renderSolidRef } from "../test-helpers/render-solid-ref.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { registerSessionTitleTarget } from "./markdown-link-display.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import "./session-progress-hovercard-registration.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";
import { SESSION_TITLE_TARGET_SELECTOR } from "./session-progress-hovercard-target.ts";

const SESSION_KEY = "agent:main:research";
const DASHBOARD_KEY = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
function row(displayName?: string, key = SESSION_KEY): GatewaySessionRow {
  return { key, kind: "direct", displayName, updatedAt: Date.now() };
}
function registerTarget(titler: SessionLinkTitler, element: HTMLElement) {
  return titler.register(
    element,
    element.querySelector<HTMLElement>(".session-label") ?? document.createElement("span"),
  );
}
function registerTargets(titler: SessionLinkTitler, host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>(SESSION_TITLE_TARGET_SELECTOR)].map((target) =>
    registerTarget(titler, target),
  );
}
function decorate(titler: SessionLinkTitler, element: HTMLElement) {
  registerTarget(titler, element);
  return titler.decorate(element);
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
  for (const [name, value] of Object.entries(attributes)) {
    expect(element.getAttribute(name), name).toBe(value);
  }
}
async function refresh(titler: SessionLinkTitler) {
  titler.refresh();
  await vi.runAllTimersAsync();
}

function sessionContext(rows: GatewaySessionRow[] = [], origin?: string): ApplicationContext {
  return {
    basePath: "",
    runtimeConfig: origin
      ? { state: { configSnapshot: { runtimeConfig: { gateway: { publicOrigin: origin } } } } }
      : undefined,
    sessions: {
      state: { result: { count: rows.length, sessions: rows } },
      subscribe: () => () => undefined,
    },
    agentSelection: { subscribe: () => () => undefined },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: {
      connectionRevision: 0,
      snapshot: {
        hello: gatewayHelloForMethods(["controlUi.sessionPreview"]),
        phase: "connected",
        selfUser: { id: "first-profile" },
      },
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

const previewResponse = (overrides: Record<string, unknown> = {}) => ({
  status: "ok",
  sessionKey: SESSION_KEY,
  title: "Research plan",
  agentId: "main",
  ...overrides,
});

function createTitler(rows: GatewaySessionRow[] = [], request = vi.fn()) {
  const titler = new SessionLinkTitler();
  titler.client = { request } as unknown as GatewayBrowserClient;
  titler.context = sessionContext(rows);
  return { host: document.createElement("div"), request, titler };
}

describe("SessionLinkTitler", () => {
  it("keeps a plain session link when the connection cannot read previews", async () => {
    const { titler, request } = createTitler();
    titler.context!.gateway.snapshot.hello = gatewayHelloForMethods(
      ["controlUi.sessionPreview", "sessions.resolve"],
      ["operator.sessions.read"],
    );
    const anchor = sessionAnchor();
    await decorate(titler, anchor);
    await vi.advanceTimersByTimeAsync(60_000);
    await refresh(titler);
    expect(request).not.toHaveBeenCalled();
    expect(anchor.textContent).toBe(SESSION_KEY);
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["a", "span"])("reconciles %s roster titles without replaying equal labels", (tag) => {
    const rows = [row("Saved research")];
    const { host, titler, request } = createTitler(rows);
    const anchor = tag === "a" ? sessionAnchor() : document.createElement("span");
    if (tag === "span") {
      anchor.dataset.sessionTitleOnly = "";
      anchor.dataset.sessionKey = SESSION_KEY;
    }
    const label = document.createElement("span");
    label.className = "session-label";
    if (tag === "a") {
      label.textContent = "Saved research";
      anchor.classList.add("markdown-session-link--titled");
    }
    anchor.replaceChildren(label);
    host.append(anchor);
    const onTitle = vi.fn();
    titler.register(anchor, label, { title: tag === "a" ? "Saved research" : undefined, onTitle });
    const observer = observe(anchor);
    try {
      for (const title of ["Saved research", "Current research", undefined]) {
        rows[0] = row(title);
        titler.refresh();
        expectTitle(anchor, title ?? SESSION_KEY);
        expect(anchor.firstElementChild).toBe(label);
        expect(anchor.classList.contains("markdown-session-link--titled")).toBe(Boolean(title));
        expect(onTitle).toHaveBeenLastCalledWith(title);
        if (tag === "span") {
          expectAttributes(anchor, { title: null, href: null });
          expect(anchor.matches("a, [href], [tabindex], .markdown-session-link")).toBe(false);
          expect(anchor.parentElement).toBe(host);
        }
        observer.takeRecords();
        titler.refresh();
        expect(observer.takeRecords()).toEqual([]);
      }
      expect(request).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
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
      titler.client = { request } as unknown as GatewayBrowserClient;
      titler.context = sessionContext();
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
    host.innerHTML = toSanitizedMarkdownHtml(`[Plan](${href})`, { sessionLinks: true });
    registerTargets(titler, host);
    const link = host.querySelector<HTMLAnchorElement>("a.markdown-session-link")!;
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

  it.each([
    { kind: "preview", count: 1, title: SESSION_KEY },
    { kind: "short", count: 1, title: "Derived plan" },
    { kind: "full", count: 100, title: "Peter's plan" },
    { kind: "full", count: 101, title: "Peter's plan" },
  ] as const)(
    "shares $count active $kind references through busy expiry",
    async ({ kind, count, title }) => {
      const pending = Promise.withResolvers<unknown>();
      const request = vi.fn((_method: string, _params: unknown) => pending.promise);
      const { host, titler } = createTitler([], request);
      titler.context = sessionContext([], "https://chat.example");
      const keys = Array.from({ length: count }, (_, index) =>
        DASHBOARD_KEY.replace("3211", index.toString(16).padStart(4, "0")),
      );
      const urls = keys.map(
        (key) => `https://chat.example/chat/main/dashboard/${key.split(":").at(-1)}`,
      );
      const source = {
        preview: SESSION_KEY,
        short: "[Plan](/chat/main/d0effac9?view=details)",
        full:
          urls.map((url) => `\`${url}\``).join(" ") + ` [Alias](${urls[0]}?view=details#latest)`,
      }[kind];
      host.innerHTML = toSanitizedMarkdownHtml(source, { sessionLinks: true });
      const releases = registerTargets(titler, host);
      titler.context.gateway.snapshot.phase = "connecting";
      await refresh(titler);
      expect(request).not.toHaveBeenCalled();
      titler.context.gateway.snapshot.phase = "connected";
      await refresh(titler);
      await refresh(titler);
      expect.soft(request, "pending requests coalesce").toHaveBeenCalledTimes(count);
      pending.reject(
        new GatewayRequestError({ code: "UNAVAILABLE", message: "busy", retryable: true }),
      );
      await refresh(titler);
      expect.soft(request, "busy failure stays cached").toHaveBeenCalledTimes(count);
      request.mockImplementation(async (method, params) => {
        const { reference, sessionKey } = params as SessionsResolveParams & { sessionKey?: string };
        const key = reference?.key ?? sessionKey ?? DASHBOARD_KEY;
        return method === "sessions.resolve"
          ? {
              ok: true,
              key,
              agentId: "main",
              displayName: kind === "full" ? "Peter's plan" : undefined,
            }
          : previewResponse({
              sessionKey: key,
              title: undefined,
              derivedTitle: kind === "short" ? "Derived plan" : undefined,
            });
      });
      await vi.advanceTimersByTimeAsync(29_999);
      await refresh(titler);
      expect.soft(request, "redraw before retry TTL").toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      await refresh(titler);
      const calls = count * 2 + (kind === "short" ? 1 : 0);
      expect.soft(request, "recovery after retry TTL").toHaveBeenCalledTimes(calls);
      const links = [...host.querySelectorAll<HTMLAnchorElement>("a.markdown-session-link")];
      const first = links[0]!;
      expect(links.map((link) => link.textContent)).toEqual(
        Array(count + (kind === "full" ? 1 : 0)).fill(title),
      );
      if (kind === "full") {
        expect(request).toHaveBeenCalledWith("sessions.resolve", {
          reference: { key: keys[0] },
          agentId: "main",
          includeGlobal: true,
          includeUnknown: true,
          allowMissing: true,
        });
      }
      expect(first.dataset.sessionKey).toBe(
        kind === "preview" ? SESSION_KEY : kind === "short" ? DASHBOARD_KEY : keys[0],
      );
      expect(first.hasAttribute("title")).toBe(false);
      const observer = observe(host);
      await refresh(titler);
      expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
      expect.soft(request).toHaveBeenCalledTimes(calls);
      if (kind === "preview") {
        const label = first.appendChild(document.createElement("span"));
        titler.register(first, label);
        request.mockResolvedValue({ status: "unavailable" });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await refresh(titler);
        await refresh(titler);
        expect(request).toHaveBeenCalledTimes(calls + 1);
        request.mockResolvedValue(previewResponse());
        await vi.advanceTimersByTimeAsync(30_000);
        await refresh(titler);
        const second = sessionAnchor();
        await decorate(titler, second);
        expectTitle(first, "Research plan");
        expectTitle(second, "Research plan");
        expect(request).toHaveBeenCalledTimes(calls + 2);
        expect(first.getAttribute("href")).toBe("/chat/main/research");
        expect(first.firstElementChild).toBe(label);
        label.textContent = "Updated by the producer";
        titler.context = sessionContext([row("Replacement Gateway")]);
        await decorate(titler, first);
        expect(first.firstElementChild).toBe(label);
        expect(first.textContent).toBe("Updated by the producer");
      }
      if (count > 100) {
        releases.forEach((release) => release());
        await decorate(titler, links.at(-2)!);
        expect(request).toHaveBeenCalledTimes(calls);
        await decorate(titler, first);
        expect(request).toHaveBeenCalledTimes(calls + 1);
      }
    },
  );

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
    const rows: GatewaySessionRow[] = [row("Shared contract", key)];
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
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.resolve") {
        return { ok: true, key: DASHBOARD_KEY, agentId: "main", displayName: "Shared contract" };
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
