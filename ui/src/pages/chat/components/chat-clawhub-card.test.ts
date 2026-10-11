/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import { i18n } from "../../../i18n/index.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createClient,
  createContext,
  createGateway,
} from "../../plugins/plugins-page.test-support.ts";
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

function detail(installed: boolean) {
  return {
    plugin: {
      id: recommendation.id,
      catalog: { name: "WhatsApp", summary: "WhatsApp Web chats", official: true },
      local: { installed, action: installed ? "manage" : "install" },
    },
  };
}

function mount(
  handler: (method: string, params: unknown) => Promise<unknown>,
  initialRecommendation: ClawHubRecommendation = recommendation,
) {
  const { client, request } = createClient(handler);
  const harness = createGateway(client);
  const context = createContext(harness.gateway);
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(
    () =>
      createComponent(ChatClawHubCard, { recommendation: initialRecommendation, agentId: "main" }),
    { wrapper: provider.wrapper },
  );
  const card = mounted.container.querySelector<HTMLElement>("openclaw-chat-clawhub-card")!;
  return { card, context, request, harness, client, unmount: mounted.unmount };
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
    await waitForSolid(() =>
      expect(card.querySelector(".chat-clawhub-card__dismiss")?.textContent?.trim()).toBe(
        "Dismiss",
      ),
    );
    const reads = request.mock.calls.length;
    translated = true;
    notifyLocale!(i18n.getLocale());
    await waitForSolid(() =>
      expect(card.querySelector(".chat-clawhub-card__dismiss")?.textContent?.trim()).toBe(
        "Ausblenden",
      ),
    );
    expect(request).toHaveBeenCalledTimes(reads);
  });

  it.each(["reconnect"] as const)(
    "opens the install review and updates after %s",
    async (completion) => {
      let installed = false;
      const { card, context, request, harness, client } = mount(async () => detail(installed));
      await vi.waitFor(() =>
        expect(card.querySelector(".chat-clawhub-card__install")?.textContent?.trim()).toBe(
          "Install",
        ),
      );
      expect(request).toHaveBeenCalledWith(
        "plugins.catalog.get",
        { id: recommendation.id },
        expect.anything(),
      );
      expect(card.querySelector(".chat-clawhub-card__dismiss")?.textContent?.trim()).toBe(
        "Dismiss",
      );
      card.querySelector<HTMLButtonElement>(".chat-clawhub-card__listing")!.click();
      expect(context.navigate).toHaveBeenLastCalledWith("plugins", {
        pathname: `/plugins/${recommendation.id}`,
        search: "",
      });
      card.querySelector<HTMLButtonElement>(".chat-clawhub-card__install")!.click();
      expect(context.navigate).toHaveBeenLastCalledWith("plugins", {
        pathname: `/plugins/${recommendation.id}`,
        search: "?action=install",
      });
      expect(request.mock.calls.every(([method]) => method !== "plugins.install")).toBe(true);

      installed = true;
      if (completion === "reconnect") {
        harness.emit(client, false);
        harness.emit(client, true);
      } else {
        harness.emit(client, true, {
          pluginCapabilities: {
            ok: true,
            generation: 1,
            descriptors: [],
            methods: [],
            controlUiTabs: [],
            controlUiWidgetKinds: [],
            pluginSurfaceUrls: {},
          },
        });
      }
      await vi.waitFor(() =>
        expect(card.querySelector(".chat-clawhub-card__installed")?.textContent).toContain(
          "Installed",
        ),
      );
      expect(card.querySelector(".chat-clawhub-card__installed svg")).not.toBeNull();
      expect(card.querySelector(".chat-clawhub-card__install")).toBeNull();
      expect(card.querySelector(".chat-clawhub-card__dismiss")).toBeNull();
      expect(card.querySelector(".chat-clawhub-card__listing")).not.toBeNull();
    },
  );

  it("rechecks official status before offering installation from an old card", async () => {
    const result = detail(false);
    result.plugin.catalog.official = false;
    const { card, context } = mount(async () => result);
    await vi.waitFor(() =>
      expect(card.querySelector(".chat-clawhub-card__install")?.textContent?.trim()).toBe(
        "View details",
      ),
    );
    expect(card.querySelector(".plugin-official-badge")).toBeNull();
    card.querySelector<HTMLButtonElement>(".chat-clawhub-card__install")!.click();
    expect(context.navigate).toHaveBeenLastCalledWith("plugins", {
      pathname: `/plugins/${recommendation.id}`,
      search: "",
    });
  });

  it("does not present a stale installed badge when status fails, and retries visibly", async () => {
    let fail = true;
    const retry = deferred<ReturnType<typeof detail>>();
    const { card } = mount(async () => {
      if (fail) {
        throw new Error("Catalog unavailable");
      }
      return retry.promise;
    });
    Object.assign(card, { recommendation: { ...recommendation, installed: true } });
    await vi.waitFor(() => expect(card.textContent).toContain("Status unavailable"));
    expect(card.querySelector(".chat-clawhub-card__installed")).toBeNull();
    fail = false;
    card.querySelector<HTMLButtonElement>(".chat-clawhub-card__dismiss")!.click();
    await vi.waitFor(() =>
      expect(card.querySelector(".chat-clawhub-card__status-skeleton")).not.toBeNull(),
    );
    expect(card.textContent).not.toContain("Checking installation");
    retry.resolve(detail(false));
    await vi.waitFor(() =>
      expect(card.querySelector(".chat-clawhub-card__install")).not.toBeNull(),
    );
    card.querySelector<HTMLButtonElement>(".chat-clawhub-card__dismiss")!.click();
    await vi.waitFor(() => expect(card.querySelector(".chat-clawhub-card")).toBeNull());
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
          pluginCapabilities: {
            ok: true,
            generation: 1,
            descriptors: [],
            methods: [],
            controlUiTabs: [],
            controlUiWidgetKinds: [],
            pluginSurfaceUrls: {},
          },
        });
      }
      await vi.waitFor(() =>
        expect(card.querySelector(".chat-clawhub-card__install")).not.toBeNull(),
      );
      old.resolve(detail(true));
      await old.promise;
      await Promise.resolve();
      expect(card.querySelector(".chat-clawhub-card__installed")).toBeNull();
    },
  );

  it.each(["catalog", "plugin"] as const)(
    "renders known %s artwork before the catalog status response arrives",
    async (owner) => {
      vi.useFakeTimers();
      const status = deferred<ReturnType<typeof detail>>();
      iconFetch[owner].mockResolvedValue("blob:known-artwork");
      const { card } = mount(() => status.promise, {
        ...recommendation,
        ...(owner === "catalog"
          ? { iconUrl: "https://example.com/known.png" }
          : { pluginId: "whatsapp" }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(iconFetch[owner]).toHaveBeenCalledOnce();
      const image = card.querySelector("img");
      expect(image?.getAttribute("src")).toBe("blob:known-artwork");
      image!.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(0);
      expect(image!.hidden).toBe(false);
      expect(card.querySelector(".chat-clawhub-card__icon.skeleton")).toBeNull();
      expect(card.querySelector(".chat-clawhub-card__status-skeleton")).not.toBeNull();
      expect(card.querySelector(".chat-clawhub-card__install")).toBeNull();
      status.resolve(detail(false));
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("retains detail-only decoded artwork through a pending and failed status refresh", async () => {
    vi.useFakeTimers();
    const refresh = deferred<ReturnType<typeof detail>>();
    const result = detail(true);
    Object.assign(result.plugin.catalog, { imageUrl: "https://example.com/detail.png" });
    iconFetch.catalog.mockResolvedValue("blob:detail-artwork");
    let refreshing = false;
    const { card, harness, client } = mount(() =>
      refreshing ? refresh.promise : Promise.resolve(result),
    );
    await vi.advanceTimersByTimeAsync(0);
    card.querySelector("img")!.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(0);
    refreshing = true;
    harness.emit(client, true, {
      pluginCapabilities: {
        ok: true,
        generation: 1,
        descriptors: [],
        methods: [],
        controlUiTabs: [],
        controlUiWidgetKinds: [],
        pluginSurfaceUrls: {},
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(card.querySelector(".chat-clawhub-card__status-skeleton")).not.toBeNull();
    expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:detail-artwork");
    expect(card.querySelector("img")?.hidden).toBe(false);
    expect(card.querySelector(".chat-clawhub-card__icon.skeleton")).toBeNull();

    refresh.reject(new Error("Catalog temporarily unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(card.textContent).toContain("Status unavailable");
    expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:detail-artwork");
    expect(card.querySelector("img")?.hidden).toBe(false);
    expect(card.querySelector(".chat-clawhub-card__installed")).toBeNull();
    expect(iconFetch.catalog).toHaveBeenCalledOnce();
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
      const result = detail(false);
      Object.assign(result.plugin.catalog, { imageUrl: iconUrl });
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
      expect(card.querySelector(".chat-clawhub-card__icon.skeleton")).toBeNull();
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
      const oldResult = detail(false);
      Object.assign(oldResult.plugin.catalog, { imageUrl: "https://example.com/old.png" });
      let current = oldResult;
      const { card, harness, unmount } = mount(async () => current);
      await vi.advanceTimersByTimeAsync(0);
      const { signal } = iconFetch.catalog.mock.calls[0]![0] as { signal: AbortSignal };
      if (boundary === "recommendation") {
        current = detail(false);
        current.plugin.id = "ch_cmVwbGFjZW1lbnQ";
        current.plugin.catalog.name = "Replacement";
        Object.assign(card, {
          recommendation: { ...recommendation, id: current.plugin.id, name: "Replacement" },
        });
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

  it.each(["skill"] as const)(
    "places the normalized %s publisher between the title and official badge",
    async () => {
      vi.useFakeTimers();
      const cardRecommendation: ClawHubRecommendation = {
        type: "clawhub",
        kind: "skill",
        id: "@openclaw/calendar",
        skillRef: "@openclaw/calendar",
        registry: "https://clawhub.ai",
        name: "Calendar",
        official: true,
        installed: false,
      };
      const { card } = mount(
        async (method) =>
          method === "skills.detail"
            ? {
                skill: { displayName: "Calendar", isOfficial: true },
                owner: { handle: "openclaw", displayName: "OpenClaw Organization" },
              }
            : { skills: [] },
        cardRecommendation,
      );
      await vi.advanceTimersByTimeAsync(0);
      const title = card.querySelector(".chat-clawhub-card__name")!;
      const publisher = title.querySelector(".plugin-card-author");
      expect(publisher?.textContent).toBe("@openclaw");
      expect(title.textContent?.trim().startsWith(cardRecommendation.name)).toBe(true);
      expect(publisher?.nextElementSibling).toBe(title.querySelector(".plugin-official-badge"));
      expect(publisher?.tagName).toBe("SPAN");
    },
  );

  it.each(["catalog"] as const)(
    "keeps %s artwork skeletons through fetch and image decoding, then clears errors",
    async (owner) => {
      const pending = deferred<string>();
      iconFetch[owner].mockReturnValue(pending.promise);
      const result = detail(false);
      Object.assign(result.plugin.catalog, { imageUrl: "https://example.com/icon.png" });
      const { card } = mount(async () => result);
      await vi.waitFor(() => expect(iconFetch[owner]).toHaveBeenCalledOnce());
      expect(card.querySelector(".chat-clawhub-card__icon.skeleton")).not.toBeNull();
      expect(card.querySelector(".chat-clawhub-card__status-skeleton")).toBeNull();
      pending.resolve("blob:whatsapp-icon");
      await vi.waitFor(() =>
        expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:whatsapp-icon"),
      );
      expect(card.querySelector(".chat-clawhub-card__icon.skeleton")).not.toBeNull();
      card.querySelector("img")!.dispatchEvent(new Event("load"));
      await vi.waitFor(() => expect(card.querySelector(".skeleton")).toBeNull());
      expect(card.querySelector("img")!.hidden).toBe(false);
      expect(card.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false");
      card.querySelector("img")!.dispatchEvent(new Event("error"));
      await vi.waitFor(() => expect(card.querySelector("img")).toBeNull());
      expect(card.querySelector(".skeleton")).toBeNull();
      expect(card.querySelector(".chat-clawhub-card__icon svg")).not.toBeNull();
    },
  );

  it.each(["stalled secondary"] as const)(
    "retains usable artwork with a %s image",
    async (failure) => {
      const catalog = deferred<string | null>();
      iconFetch.catalog.mockReturnValue(catalog.promise);
      iconFetch.plugin.mockResolvedValue("blob:package");
      const result = detail(true);
      Object.assign(result.plugin.catalog, {
        packageName: "@openclaw/whatsapp",
        imageUrl: "https://example.com/catalog.png",
      });
      Object.assign(result.plugin.local, { pluginId: "whatsapp" });
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
        await vi.waitFor(() =>
          expect(card.querySelector(".chat-clawhub-card__icon svg")).not.toBeNull(),
        );
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

  it.each([["https://clawhub.ai", undefined, true]] as const)(
    "matches native skill identity (%s, %s) and keeps its agent in the detail link",
    async (registry, requestedReference, installed) => {
      const skill: ClawHubRecommendation = {
        type: "clawhub",
        kind: "skill",
        id: "@openclaw/calendar",
        skillRef: "@openclaw/calendar",
        registry: "https://clawhub.ai",
        name: "Calendar",
        official: true,
        installed: false,
      };
      const { card, context } = mount(async (method) =>
        method === "skills.detail"
          ? { skill: { displayName: "Calendar", isOfficial: true } }
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
      );
      Object.assign(card, { recommendation: skill, agentId: "research" });
      await vi.waitFor(() =>
        expect(
          card.querySelector(
            installed ? ".chat-clawhub-card__installed" : ".chat-clawhub-card__install",
          ),
        ).not.toBeNull(),
      );
      expect(Boolean(card.querySelector(".chat-clawhub-card__installed"))).toBe(installed);
      card.querySelector<HTMLButtonElement>(".chat-clawhub-card__listing")!.click();
      expect(context.navigate).toHaveBeenCalledWith("skills", {
        search: "?clawhub=%40openclaw%2Fcalendar&agent=research",
      });
    },
  );
});
