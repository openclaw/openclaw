/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import { i18n } from "../../../i18n/index.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createPluginCapabilities,
  createClient,
  createContext,
  createGateway,
} from "../../plugins/plugins-page.test-support.ts";
import { subscribeClawHubCardUpdates } from "./chat-clawhub-card-updates.ts";
import { ChatClawHubCard } from "./chat-clawhub-card.tsx";

const iconFetch = vi.hoisted(() => ({ catalog: vi.fn(), plugin: vi.fn() }));
vi.mock("../../plugins/icon-loader.ts", () => ({
  fetchCatalogIconBlobUrl: (...args: unknown[]) => iconFetch.catalog(...args),
  fetchPluginIconBlobUrl: (...args: unknown[]) => iconFetch.plugin(...args),
}));

const recommendation: ClawHubRecommendation = {
  type: "clawhub",
  kind: "plugin",
  id: "ch_d2hhdHNhcHA",
  name: "WhatsApp",
  description: "WhatsApp Web chats",
  official: true,
  installed: false,
};

const skillRecommendation: ClawHubRecommendation = {
  type: "clawhub",
  kind: "skill",
  id: "@openclaw/calendar",
  skillRef: "@openclaw/calendar",
  registry: "https://clawhub.ai",
  name: "Calendar",
  official: true,
  installed: false,
};

function part(card: ParentNode, name: string) {
  return card.querySelector<HTMLElement>(`.chat-clawhub-card__${name}`);
}

function expectPublisher(card: ParentNode, name: string) {
  const title = part(card, "name")!;
  const publisher = title.querySelector(".plugin-card-author");
  expect(publisher?.textContent).toBe("@openclaw");
  expect(title.textContent?.trim().startsWith(name)).toBe(true);
  expect(publisher?.nextElementSibling).toBe(title.querySelector(".plugin-official-badge"));
  expect(publisher?.tagName).toBe("SPAN");
}

function detail(
  installed: boolean,
  catalog: { official?: boolean; author?: string; imageUrl?: string; packageName?: string } = {},
  local: { pluginId?: string } = {},
) {
  return {
    plugin: {
      id: recommendation.id,
      catalog: { name: "WhatsApp", summary: "WhatsApp Web chats", official: true, ...catalog },
      local: { installed, action: installed ? "manage" : "install", ...local },
    },
  };
}

function mount(
  handler: (method: string, params: unknown) => Promise<unknown>,
  initialRecommendation: ClawHubRecommendation = recommendation,
  agentId = "main",
) {
  const { client, request } = createClient(handler);
  const harness = createGateway(client);
  const context = createContext(harness.gateway);
  const provider = createSolidApplicationContextProvider(context);
  const [currentRecommendation, setRecommendation] = createSignal(initialRecommendation);
  const mounted = mountSolid(
    () =>
      createComponent(ChatClawHubCard, {
        get recommendation() {
          return currentRecommendation();
        },
        agentId,
      }),
    { wrapper: provider.wrapper },
  );
  const card = mounted.container.querySelector<HTMLElement>("openclaw-chat-clawhub-card")!;
  return { card, context, request, harness, client, unmount: mounted.unmount, setRecommendation };
}

describe("ClawHub chat recommendations", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    iconFetch.catalog.mockReset().mockResolvedValue(null);
    iconFetch.plugin.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares card wakeups and skips snapshots that cannot change load admission", () => {
    const { client } = createClient(async () => detail(false));
    const harness = createGateway(client);
    const subscribe = vi.spyOn(harness.gateway, "subscribe");
    const documentListen = vi.spyOn(document, "addEventListener");
    const windowListen = vi.spyOn(window, "addEventListener");
    let visible = true;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      visible ? "visible" : "hidden",
    );
    const notify = vi.fn();
    const stops = Array.from({ length: 100 }, () =>
      subscribeClawHubCardUpdates(harness.gateway, document, notify),
    );
    onTestFinished(() => stops.forEach((stop) => stop()));
    expect(subscribe).toHaveBeenCalledOnce();
    expect(documentListen.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(
      1,
    );
    expect(windowListen.mock.calls.filter(([type]) => type === "focus")).toHaveLength(1);

    harness.emit(client, true, { lastError: "Unrelated status", sessionKey: "another-session" });
    expect(notify).not.toHaveBeenCalled();
    harness.emit(client, false);
    expect(notify.mock.calls).toEqual(Array.from({ length: 100 }, () => [false]));
    notify.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(notify).not.toHaveBeenCalled();
    harness.emit(client, true);
    expect(notify).toHaveBeenCalledTimes(100);
    notify.mockClear();

    visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(notify).not.toHaveBeenCalled();
    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(notify.mock.calls).toEqual(Array.from({ length: 300 }, () => [true]));

    notify.mockClear();
    stops.slice(0, 99).forEach((stop) => stop());
    window.dispatchEvent(new Event("focus"));
    expect(notify).toHaveBeenCalledOnce();
    stops[99]!();
    notify.mockClear();
    window.dispatchEvent(new Event("focus"));
    harness.emit(client, false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("delivers a synchronous connection retirement when a callback replaces the snapshot", () => {
    const { client } = createClient(async () => detail(false));
    const harness = createGateway(client);
    let replaced = false;
    const stopFirst = subscribeClawHubCardUpdates(harness.gateway, document, () => {
      if (!replaced) {
        replaced = true;
        harness.emit(client, false, { lastError: "Nested publication" });
      }
    });
    const notify = vi.fn();
    const stopSecond = subscribeClawHubCardUpdates(harness.gateway, document, notify);
    onTestFinished(() => {
      stopFirst();
      stopSecond();
    });
    harness.emit(client, false);
    expect(notify).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("isolates card callbacks and skips subscribers retired during the same wakeup", () => {
    const { client } = createClient(async () => detail(false));
    const harness = createGateway(client);
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const retired = vi.fn();
    const surviving = vi.fn();
    let stopRetired = () => {};
    const failure = new Error("Card refresh failed");
    const stopFirst = subscribeClawHubCardUpdates(harness.gateway, document, () => {
      stopRetired();
      throw failure;
    });
    stopRetired = subscribeClawHubCardUpdates(harness.gateway, document, retired);
    const stopLast = subscribeClawHubCardUpdates(harness.gateway, document, surviving);
    onTestFinished(() => {
      stopFirst();
      stopRetired();
      stopLast();
    });
    harness.emit(client, false);
    expect(retired).not.toHaveBeenCalled();
    expect(surviving).toHaveBeenCalledExactlyOnceWith(false);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("refreshes translated actions without reloading catalog status", async () => {
    const translate = i18n.t.bind(i18n);
    const subscribe = i18n.subscribe.bind(i18n);
    let notifyLocale: Parameters<typeof i18n.subscribe>[0] | undefined;
    let translated = false;
    vi.spyOn(i18n, "t").mockImplementation((key, params) =>
      translated && key === "common.dismiss" ? "Ausblenden" : translate(key, params),
    );
    vi.spyOn(i18n, "subscribe").mockImplementation((listener) => {
      notifyLocale = listener;
      return subscribe(listener);
    });
    const { card, request } = mount(async () => detail(false));
    await waitForSolid(() => expect(part(card, "dismiss")?.textContent?.trim()).toBe("Dismiss"));
    const reads = request.mock.calls.length;
    translated = true;
    notifyLocale!(i18n.getLocale());
    await waitForSolid(() => expect(part(card, "dismiss")?.textContent?.trim()).toBe("Ausblenden"));
    expect(request).toHaveBeenCalledTimes(reads);
  });

  it("opens the install review and updates after reconnect", async () => {
    let installed = false;
    const { card, context, request, harness, client } = mount(async () =>
      detail(installed, { author: "@openclaw", packageName: "@openclaw/whatsapp" }),
    );
    await vi.waitFor(() => expect(part(card, "install")?.textContent?.trim()).toBe("Install"));
    expectPublisher(card, recommendation.name);
    await vi.waitFor(() => expect(part(card, "icon svg")).not.toBeNull());
    expect(card.querySelector("img, .skeleton")).toBeNull();
    expect(iconFetch.plugin).not.toHaveBeenCalled();
    expect(part(card, "dismiss")?.textContent?.trim()).toBe("Dismiss");
    part(card, "listing")!.click();
    expect(context.navigate).toHaveBeenLastCalledWith("plugins", {
      pathname: `/plugins/${recommendation.id}`,
      search: "",
    });
    part(card, "install")!.click();
    expect(context.navigate).toHaveBeenLastCalledWith("plugins", {
      pathname: `/plugins/${recommendation.id}`,
      search: "?action=install",
    });
    expect(request.mock.calls.every(([method]) => method !== "plugins.install")).toBe(true);

    installed = true;
    harness.emit(client, false);
    harness.emit(client, true);
    await vi.waitFor(() => expect(part(card, "installed")?.textContent).toContain("Installed"));
    expect(part(card, "installed svg")).not.toBeNull();
    expect(part(card, "install")).toBeNull();
    expect(part(card, "dismiss")).toBeNull();
    expect(part(card, "listing")).not.toBeNull();
  });

  it("rechecks official status before offering installation from an old card", async () => {
    const result = detail(false, { official: false });
    const { card, context } = mount(async () => result);
    await vi.waitFor(() => expect(part(card, "install")?.textContent?.trim()).toBe("View details"));
    expect(card.querySelector(".plugin-official-badge")).toBeNull();
    part(card, "install")!.click();
    expect(context.navigate).toHaveBeenLastCalledWith("plugins", {
      pathname: `/plugins/${recommendation.id}`,
      search: "",
    });
  });

  it.each(["connection", "plugin generation"] as const)(
    "rejects old status responses after the %s changes",
    async (boundary) => {
      const old = deferred<ReturnType<typeof detail>>();
      let pending = true;
      const { card, harness, request, client } = mount(() =>
        pending ? old.promise : Promise.resolve(detail(false)),
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalled());
      expect(card.querySelector(".skeleton")).not.toBeNull();
      expect(card.textContent).not.toContain("Checking installation");
      if (boundary === "connection") {
        const next = createClient(async () => detail(false));
        harness.emit(next.client, true);
      } else {
        pending = false;
        harness.emit(client, true, {
          pluginCapabilities: createPluginCapabilities(1),
        });
      }
      await vi.waitFor(() => expect(part(card, "install")).not.toBeNull());
      old.resolve(detail(true));
      await old.promise;
      await Promise.resolve();
      expect(part(card, "installed")).toBeNull();
    },
  );

  it("retains detail-only decoded artwork through pending, failed, and retried status refreshes", async () => {
    vi.useFakeTimers();
    const refresh = deferred<ReturnType<typeof detail>>();
    const retry = deferred<ReturnType<typeof detail>>();
    const result = detail(true, { imageUrl: "https://example.com/detail.png" });
    iconFetch.catalog.mockResolvedValue("blob:detail-artwork");
    let response = Promise.resolve(result);
    const { card, harness, client } = mount(() => response, { ...recommendation, installed: true });
    await vi.advanceTimersByTimeAsync(0);
    const image = card.querySelector("img")!;
    image.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(0);
    response = refresh.promise;
    harness.emit(client, true, {
      pluginCapabilities: createPluginCapabilities(1),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(part(card, "status-skeleton")).not.toBeNull();
    expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:detail-artwork");
    expect(card.querySelector("img")?.hidden).toBe(false);
    expect(part(card, "icon.skeleton")).toBeNull();

    refresh.reject(new Error("Catalog temporarily unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(card.textContent).toContain("Status unavailable");
    expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:detail-artwork");
    expect(card.querySelector("img")?.hidden).toBe(false);
    expect(part(card, "installed")).toBeNull();
    expect(iconFetch.catalog).toHaveBeenCalledOnce();

    response = retry.promise;
    part(card, "dismiss")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(part(card, "status-skeleton")).not.toBeNull();
    expect(part(card, "dismiss")).toBeNull();
    expect(part(card, "installed")).toBeNull();
    expect(part(card, "install")).toBeNull();
    expect(card.querySelector("img")).toBe(image);
    expect(image.hidden).toBe(false);
    expect(iconFetch.catalog).toHaveBeenCalledOnce();

    retry.resolve(detail(false, { imageUrl: "https://example.com/detail.png" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(part(card, "status-skeleton")).toBeNull();
    expect(part(card, "install")).not.toBeNull();
    expect(card.querySelector("img")).toBe(image);
    expect(image.hidden).toBe(false);
    expect(iconFetch.catalog).toHaveBeenCalledOnce();
    part(card, "dismiss")!.click();
    await vi.waitFor(() => expect(card.querySelector(".chat-clawhub-card")).toBeNull());
  });

  it.each(["before", "after"] as const)(
    "recovers an early catalog miss returned %s URL admission",
    async (timing) => {
      vi.useFakeTimers();
      const status = deferred<ReturnType<typeof detail>>();
      const iconUrl = "https://example.com/readmitted.png";
      const early = deferred<string | null>();
      iconFetch.catalog.mockReturnValueOnce(early.promise).mockResolvedValueOnce("blob:readmitted");
      const { card } = mount(() => status.promise, { ...recommendation, iconUrl });
      await vi.advanceTimersByTimeAsync(0);
      expect(iconFetch.catalog).toHaveBeenCalledOnce();
      if (timing === "before") {
        early.resolve(null);
        await vi.advanceTimersByTimeAsync(0);
      }
      const result = detail(false, { imageUrl: iconUrl });
      status.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
      if (timing === "after") {
        early.resolve(null);
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(iconFetch.catalog).toHaveBeenCalledTimes(2);
      expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:readmitted");
      card.querySelector("img")!.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(0);
      expect(part(card, "icon.skeleton")).toBeNull();
    },
  );

  it.each(["recommendation", "gateway", "disconnect"] as const)(
    "aborts and releases stale artwork after %s replacement",
    async (boundary) => {
      vi.useFakeTimers();
      const NativeUrl = URL;
      const revokeObjectURL = vi.fn();
      vi.stubGlobal(
        "URL",
        class extends NativeUrl {
          static override revokeObjectURL = revokeObjectURL;
        },
      );
      const pending = deferred<string>();
      iconFetch.catalog.mockReturnValueOnce(pending.promise).mockResolvedValue(null);
      const oldResult = detail(false, { imageUrl: "https://example.com/old.png" });
      let current = oldResult;
      const { card, harness, unmount, setRecommendation } = mount(async () => current);
      await vi.advanceTimersByTimeAsync(0);
      const { signal } = iconFetch.catalog.mock.calls[0]![0] as { signal: AbortSignal };
      if (boundary === "recommendation") {
        current = detail(false);
        current.plugin.id = "ch_cmVwbGFjZW1lbnQ";
        current.plugin.catalog.name = "Replacement";
        setRecommendation({ ...recommendation, id: current.plugin.id, name: "Replacement" });
      } else if (boundary === "gateway") {
        const next = createClient(async () => detail(false));
        harness.emit(next.client, true);
      } else {
        unmount();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(signal.aborted).toBe(true);
      pending.resolve("blob:stale-artwork");
      await vi.advanceTimersByTimeAsync(0);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:stale-artwork");
      expect(card.querySelector('img[src="blob:stale-artwork"]')).toBeNull();
    },
  );

  it.each([
    ["catalog", true],
    ["plugin", true],
    ["catalog", false],
    ["plugin", false],
  ] as const)(
    "decodes %s artwork independently of status (known=%s) and clears failed images",
    async (owner, known) => {
      const pending = deferred<string>();
      const status = deferred<ReturnType<typeof detail>>();
      const iconUrl = "https://example.com/icon.png";
      iconFetch[owner].mockReturnValue(pending.promise);
      const result = detail(
        owner === "plugin",
        owner === "catalog" ? { imageUrl: iconUrl } : {},
        owner === "plugin" ? { pluginId: "custom-channel" } : {},
      );
      const { card } = mount(() => status.promise, {
        ...recommendation,
        ...(known ? (owner === "catalog" ? { iconUrl } : { pluginId: "custom-channel" }) : {}),
      });
      if (!known) {
        status.resolve(result);
      }
      await vi.waitFor(() => {
        expect(iconFetch[owner]).toHaveBeenCalledOnce();
        expect(Boolean(part(card, "status-skeleton"))).toBe(known);
      });
      expect(part(card, "icon.skeleton")).not.toBeNull();
      pending.resolve("blob:whatsapp-icon");
      await vi.waitFor(() =>
        expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:whatsapp-icon"),
      );
      expect(part(card, "icon.skeleton")).not.toBeNull();
      const image = card.querySelector("img")!;
      image.dispatchEvent(new Event("load"));
      await vi.waitFor(() => expect(part(card, "icon.skeleton")).toBeNull());
      expect(image.hidden).toBe(false);
      if (known) {
        expect(part(card, "status-skeleton")).not.toBeNull();
        expect(part(card, "install")).toBeNull();
        status.resolve(result);
      }
      await vi.waitFor(() =>
        expect(card.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false"),
      );
      image.dispatchEvent(new Event("error"));
      await vi.waitFor(() => expect(card.querySelector("img")).toBeNull());
      expect(card.querySelector(".skeleton")).toBeNull();
      expect(part(card, "icon svg")).not.toBeNull();
    },
  );

  it.each(["stalled secondary", "failed primary"] as const)(
    "retains usable artwork with a %s image",
    async (failure) => {
      const catalog = deferred<string | null>();
      iconFetch.catalog.mockReturnValue(catalog.promise);
      iconFetch.plugin.mockResolvedValue("blob:package");
      const result = detail(
        true,
        {
          packageName: "@openclaw/whatsapp",
          imageUrl: "https://example.com/catalog.png",
        },
        { pluginId: "whatsapp" },
      );
      const { card } = mount(async () => result);
      await vi.waitFor(() =>
        expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:package"),
      );
      if (failure === "stalled secondary") {
        card.querySelector("img")!.dispatchEvent(new Event("load"));
        await vi.waitFor(() => expect(card.querySelector(".skeleton")).toBeNull());
        expect(card.querySelector("img")!.hidden).toBe(false);
      } else {
        card.querySelector("img")!.dispatchEvent(new Event("error"));
        catalog.resolve("blob:catalog");
        await vi.waitFor(() =>
          expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:catalog"),
        );
        card.querySelector("img")!.dispatchEvent(new Event("error"));
        await vi.waitFor(() => expect(part(card, "icon svg")).not.toBeNull());
        expect(card.querySelector(".skeleton")).toBeNull();
      }
      catalog.resolve(null);
    },
  );

  it("retains validated assistant cards and rejects cards pasted into a user message", () => {
    expect(normalizeMessage({ role: "assistant", content: [recommendation] }).content).toEqual([
      recommendation,
    ]);
    expect(normalizeMessage({ role: "user", content: [recommendation] }).content).toEqual([]);
    expect(
      normalizeMessage({ role: "assistant", content: [{ ...recommendation, installed: "yes" }] })
        .content,
    ).toEqual([]);
  });

  it.each([
    ["https://clawhub.ai", undefined, true],
    ["https://other.example", undefined, false],
    ["https://clawhub.ai", "skills-sh:openclaw/skills/calendar", false],
  ] as const)(
    "matches native skill identity (%s, %s) and keeps its agent in the detail link",
    async (registry, requestedReference, installed) => {
      const skill = skillRecommendation;
      const { card, context } = mount(
        async (method) =>
          method === "skills.detail"
            ? {
                skill: { displayName: "Calendar", isOfficial: true },
                owner: { handle: "openclaw" },
              }
            : {
                skills: [
                  {
                    clawhub: {
                      status: "linked",
                      valid: true,
                      registry,
                      requestedReference,
                      ownerHandle: "openclaw",
                      slug: "calendar",
                    },
                  },
                ],
              },
        skill,
        "research",
      );
      await vi.waitFor(() =>
        expect(
          card.querySelector(
            installed ? ".chat-clawhub-card__installed" : ".chat-clawhub-card__install",
          ),
        ).not.toBeNull(),
      );
      expect(Boolean(part(card, "installed"))).toBe(installed);
      expectPublisher(card, skill.name);
      part(card, "listing")!.click();
      expect(context.navigate).toHaveBeenCalledWith("skills", {
        search: "?clawhub=%40openclaw%2Fcalendar&agent=research",
      });
    },
  );
});
