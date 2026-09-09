/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { i18n } from "../../../i18n/index.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import {
  createClient,
  createContext,
  createGateway,
  deferred,
} from "../../plugins/plugins-page.test-support.ts";
import "./chat-clawhub-card.ts";

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

function mount(handler: (method: string, params: unknown) => Promise<unknown>) {
  const { client, request } = createClient(handler);
  const harness = createGateway(client);
  const context = createContext(harness.gateway);
  const provider = createApplicationContextProvider(context);
  const card = document.createElement("openclaw-chat-clawhub-card");
  Object.assign(card, { recommendation, agentId: "main" });
  provider.append(card);
  document.body.append(provider);
  return { card, context, request, harness, client };
}

describe("ClawHub chat recommendations", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("opens the in-app listing or install review, then replaces the offer after installation", async () => {
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
    harness.emit(client, false);
    harness.emit(client, true);
    await vi.waitFor(() =>
      expect(card.querySelector(".chat-clawhub-card__installed")?.textContent).toContain(
        "Installed",
      ),
    );
    expect(card.querySelector(".chat-clawhub-card__installed svg")).not.toBeNull();
    expect(card.querySelector(".chat-clawhub-card__install")).toBeNull();
    expect(card.querySelector(".chat-clawhub-card__dismiss")).toBeNull();
    expect(card.querySelector(".chat-clawhub-card__listing")).not.toBeNull();
  });

  it("rechecks official status before offering installation from an old card", async () => {
    const result = detail(false);
    result.plugin.catalog.official = false;
    const { card, context } = mount(async () => result);
    await vi.waitFor(() =>
      expect(card.querySelector(".chat-clawhub-card__install")?.textContent?.trim()).toBe(
        "View details",
      ),
    );
    expect(card.querySelector(".chat-clawhub-card__official")).toBeNull();
    card.querySelector<HTMLButtonElement>(".chat-clawhub-card__install")!.click();
    expect(context.navigate).toHaveBeenLastCalledWith("plugins", {
      pathname: `/plugins/${recommendation.id}`,
      search: "",
    });
  });

  it("does not present a stale installed badge when status fails, and retries visibly", async () => {
    let fail = true;
    const { card } = mount(async () => {
      if (fail) {
        throw new Error("Catalog unavailable");
      }
      return detail(false);
    });
    Object.assign(card, { recommendation: { ...recommendation, installed: true } });
    await vi.waitFor(() => expect(card.textContent).toContain("Status unavailable"));
    expect(card.querySelector(".chat-clawhub-card__installed")).toBeNull();
    fail = false;
    card.querySelector<HTMLButtonElement>(".chat-clawhub-card__dismiss")!.click();
    await vi.waitFor(() =>
      expect(card.querySelector(".chat-clawhub-card__install")).not.toBeNull(),
    );
    card.querySelector<HTMLButtonElement>(".chat-clawhub-card__dismiss")!.click();
    await vi.waitFor(() => expect(card.querySelector(".chat-clawhub-card")).toBeNull());
  });

  it("rejects old Gateway responses after the connection changes", async () => {
    const old = deferred<ReturnType<typeof detail>>();
    const { card, harness, request } = mount(() => old.promise);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const next = createClient(async () => detail(false));
    harness.emit(next.client, true);
    await vi.waitFor(() =>
      expect(card.querySelector(".chat-clawhub-card__install")).not.toBeNull(),
    );
    old.resolve(detail(true));
    await old.promise;
    await Promise.resolve();
    expect(card.querySelector(".chat-clawhub-card__installed")).toBeNull();
  });

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
