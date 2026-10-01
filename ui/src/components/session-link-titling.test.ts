/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";

const SESSION_KEY = "agent:main:research";

function sessionContext(rows: GatewaySessionRow[] = []): ApplicationContext {
  return {
    basePath: "",
    sessions: { state: { result: { count: rows.length, sessions: rows } } },
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
  const titler = new SessionLinkTitler(host);
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

  it("seeds a titled link and canonical href from the loaded session roster", async () => {
    const row = {
      key: SESSION_KEY,
      agentId: "main",
      kind: "direct",
      displayName: "Cached research",
      updatedAt: Date.now(),
    } as GatewaySessionRow;
    const { request, titler } = createTitler([row]);
    const anchor = sessionAnchor();

    await titler.decorate(anchor);

    expect(anchor.textContent).toBe("Cached research");
    expect(anchor.querySelector(":scope > .session-label")?.textContent).toBe("Cached research");
    expect(anchor.classList.contains("markdown-session-link--titled")).toBe(true);
    expect(anchor.title).toBe(SESSION_KEY);
    expect(anchor.getAttribute("href")).toBe("/chat/main/research");
    expect(request).not.toHaveBeenCalled();
  });

  it("decorates disclosure labels without making them navigation targets", async () => {
    const { host, request, titler } = createTitler([
      { key: SESSION_KEY, kind: "direct", displayName: "Cached research", updatedAt: Date.now() },
    ]);
    const label = document.createElement("span");
    label.dataset.sessionTitleOnly = "";
    label.dataset.sessionKey = SESSION_KEY;
    label.innerHTML = '<span class="session-label"></span>';
    host.append(label);
    titler.refresh();
    expect(label.textContent).toBe("Cached research");
    expect(label.parentElement).toBe(host);
    expect(label.matches("a, [href], [tabindex], .markdown-session-link")).toBe(false);
    expect(request).not.toHaveBeenCalled();
    titler.context = sessionContext([
      { key: SESSION_KEY, kind: "direct", displayName: "Current research", updatedAt: Date.now() },
    ]);
    await titler.decorate(label);
    expect(label.textContent).toBe("Current research");
    expect(label.matches("a, [href], [tabindex], .markdown-session-link")).toBe(false);
  });

  it("loads an unseeded title from the preview RPC and reuses its cache", async () => {
    const request = vi.fn().mockResolvedValue(previewResponse());
    const { titler } = createTitler([], request);
    const first = sessionAnchor();
    const second = sessionAnchor();

    await titler.decorate(first, true);
    await titler.decorate(second, true);

    expect(first.textContent).toBe("Research plan");
    expect(second.textContent).toBe("Research plan");
    expect(first.querySelectorAll(":scope > .session-label")).toHaveLength(1);
    await titler.decorate(first, true);
    expect(first.querySelectorAll(":scope > .session-label")).toHaveLength(1);
    expect(first.getAttribute("href")).toBe("/chat/main/research");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("controlUi.sessionPreview", { sessionKey: SESSION_KEY });
  });

  it("preserves a producer-owned label node when resolving its title", async () => {
    const request = vi.fn().mockResolvedValue(previewResponse());
    const { titler } = createTitler([], request);
    const anchor = sessionAnchor();
    const label = document.createElement("span");
    label.className = "session-label";
    label.textContent = SESSION_KEY;
    anchor.replaceChildren(label);

    await titler.decorate(anchor, true);

    expect(anchor.firstElementChild).toBe(label);
    expect(label.textContent).toBe("Research plan");
    label.textContent = "Updated by the producer";
    expect(anchor.textContent).toBe("Updated by the producer");

    titler.context = sessionContext([
      {
        key: SESSION_KEY,
        kind: "direct",
        displayName: "Replacement Gateway",
        updatedAt: Date.now(),
      },
    ]);
    await titler.decorate(anchor, true);

    expect(anchor.firstElementChild).toBe(label);
    expect(anchor.textContent).toBe("Updated by the producer");
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
    const decorating = titler.decorate(previous, true);
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
    await titler.decorate(current, true);

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

    await titler.decorate(sessionAnchor(), true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await titler.decorate(sessionAnchor(), true);
    await titler.decorate(sessionAnchor(), true);
    expect(request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await titler.decorate(sessionAnchor(), true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retires a retained URL title when the replacement roster cannot resolve it", async () => {
    const key = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
    const { host, titler, request } = createTitler([
      { key, kind: "direct", displayName: "Previous Gateway", updatedAt: Date.now() },
    ]);
    host.innerHTML = toSanitizedMarkdownHtml(
      "[Contract](/chat/main/d0effac9?view=details#latest)",
      {
        sessionLinks: true,
      },
    );
    const link = host.querySelector<HTMLAnchorElement>("a.markdown-session-link")!;
    await titler.decorate(link);
    const label = link.firstElementChild;
    expect(link.textContent).toBe("Previous Gateway");

    titler.context = sessionContext();
    await titler.decorate(link, true);

    expect(link.textContent).toBe(key);
    expect(link.firstElementChild).toBe(label);
    expect(link.classList.contains("markdown-session-link--titled")).toBe(false);
    expect(link.hasAttribute("title")).toBe(false);
    expect(link.dataset.sessionKey).toBeUndefined();
    expect(link.getAttribute("href")).toBe("/chat/main/d0effac9?view=details#latest");
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves short references only from the loaded roster", async () => {
    const sessionKey = "agent:main:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
    const row = {
      key: sessionKey,
      agentId: "main",
      kind: "direct",
      displayName: "Research plan",
      updatedAt: Date.now(),
    } as GatewaySessionRow;
    const request = vi.fn().mockResolvedValue(previewResponse());
    const unseeded = createTitler([], request).titler;
    const unseededAnchor = document.createElement("a");
    unseededAnchor.className = "markdown-session-link";
    unseededAnchor.href = "/chat/main/research-plan-2139bddb";

    await unseeded.decorate(unseededAnchor, true);
    expect(request).not.toHaveBeenCalled();

    const seeded = createTitler([row], request).titler;
    const seededAnchor = unseededAnchor.cloneNode() as HTMLAnchorElement;
    await seeded.decorate(seededAnchor, true);
    expect(seededAnchor.textContent).toBe("Research plan");
    expect(seededAnchor.title).toBe(sessionKey);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ["bare URL", `${location.origin}/chat/main/d0effac9?view=details#latest`],
    ["relative href", "[Contract](/chat/main/old-name-d0effac9?view=details#latest)"],
    ["slug-only href", "[Contract](/chat/main/shared-contract?view=details#latest)"],
    ["inline code", "`/chat/main/d0effac9?view=details#latest`"],
    ["public URL", "https://chat.example/chat/main/d0effac9?view=details#latest"],
    ["public inline code", "`https://chat.example/chat/main/d0effac9?view=details#latest`"],
  ])(
    "connects %s to the same hover identity without losing route intent",
    async (_kind, markdown) => {
      const key = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
      const row: GatewaySessionRow = {
        key,
        kind: "direct",
        displayName: "Shared contract",
        updatedAt: Date.now(),
      };
      const { host, titler, request } = createTitler([row]);
      titler.context = {
        ...sessionContext([row]),
        runtimeConfig: {
          state: {
            configSnapshot: {
              runtimeConfig: { gateway: { publicOrigin: "https://CHAT.example:443/" } },
            },
          },
        },
      } as unknown as ApplicationContext;
      host.innerHTML = toSanitizedMarkdownHtml(markdown, { sessionLinks: true, fileLinks: true });
      titler.connect();
      await Promise.resolve();
      const link = host.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(link?.dataset.sessionKey).toBe(key);
      expect(link?.textContent).toBe("Shared contract");
      expect(link?.getAttribute("href")).toMatch(
        /^\/chat\/main\/(?:.*d0effac9|shared-contract)\?view=details#latest$/,
      );
      expect(link?.hasAttribute("target")).toBe(false);
      expect(request).not.toHaveBeenCalled();
      titler.disconnect();
    },
  );

  it("keeps unknown and ambiguous URLs navigable without a hover identity, then refreshes a known row", () => {
    const key = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
    const rows: GatewaySessionRow[] = [];
    const { host, titler, request } = createTitler(rows);
    host.innerHTML = toSanitizedMarkdownHtml("[Contract](/chat/main/d0effac9)", {
      sessionLinks: true,
    });
    titler.refresh();
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    expect(link.dataset.sessionKey).toBeUndefined();
    expect(link.getAttribute("href")).toBe("/chat/main/d0effac9");
    rows.push({ key, kind: "direct", displayName: "Shared contract", updatedAt: Date.now() });
    titler.refresh();
    expect(link.dataset.sessionKey).toBe(key);
    rows.push({ key: key.replace("3211", "4322"), kind: "direct", updatedAt: Date.now() });
    titler.refresh();
    expect(link.dataset.sessionKey).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps unchanged session links free of mutations across roster refreshes", () => {
    const key = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
    const rows: GatewaySessionRow[] = [
      { key, kind: "direct", displayName: "Shared contract", updatedAt: Date.now() },
    ];
    const { host, titler, request } = createTitler(rows);
    host.innerHTML = toSanitizedMarkdownHtml(
      "[First](/chat/main/d0effac9?view=details#first) " +
        "[Second](/chat/main/d0effac9?view=details#second) " +
        "[Unknown](/chat/main/aabbccdd)",
      { sessionLinks: true },
    );
    titler.refresh();
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a.markdown-session-link")];
    const observer = new MutationObserver(() => undefined);
    observer.observe(host, { attributes: true, childList: true, subtree: true });
    try {
      rows[0] = { ...rows[0]!, updatedAt: Date.now() + 1 };
      titler.refresh();
      expect(observer.takeRecords()).toEqual([]);
      expect(links.map((link) => link.getAttribute("href"))).toEqual([
        "/chat/main/d0effac9?view=details#first",
        "/chat/main/d0effac9?view=details#second",
        "/chat/main/aabbccdd",
      ]);

      rows.push({ key: key.replace("3211", "4322"), kind: "direct", updatedAt: Date.now() });
      titler.refresh();
      expect(links.map((link) => link.dataset.sessionKey)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      observer.takeRecords();
      titler.refresh();
      expect(observer.takeRecords()).toEqual([]);

      rows.pop();
      titler.refresh();
      expect(links.map((link) => link.dataset.sessionKey)).toEqual([key, key, undefined]);
      expect(request).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
  });

  it("leaves remote links and code spans plain", () => {
    const { host, titler } = createTitler();
    host.innerHTML = toSanitizedMarkdownHtml(
      "[Remote](https://elsewhere.example/chat/main/d0effac9) `https://elsewhere.example/chat/main/d0effac9`",
      { sessionLinks: true },
    );
    titler.refresh();
    expect(host.querySelector(".markdown-session-link")).toBeNull();
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.querySelector("a")?.target).toBe("_blank");
    expect(host.querySelector("code")?.parentElement?.tagName).not.toBe("A");
  });
});
