import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { createFrameClock } from "../../test-helpers/animation-frame-clock.ts";
import type { ChatDetailPanel } from "../chat/components/chat-sidebar-view-types.ts";
import { DirectDictationControl } from "../chat/composer-direct-dictation.ts";
import type { NewSessionRouteData } from "./location.ts";
import "./new-session-page-entry.ts";

type NewSessionElement = HTMLElement & {
  data: NewSessionRouteData | undefined;
  focusComposer(): void;
  updateComplete: Promise<boolean>;
};

function routeData(agentId: string, catalogId = ""): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId,
    catalogLabel: "",
    startTerminal: false,
  };
}

async function mount(data: NewSessionRouteData): Promise<NewSessionElement> {
  const page = document.createElement("openclaw-new-session-page") as NewSessionElement;
  page.data = data;
  document.body.append(page);
  await settle(page);
  return page;
}

async function settle(page: NewSessionElement) {
  await page.updateComplete;
  await page.updateComplete;
}

async function enterMessage(page: NewSessionElement, value: string) {
  const textarea = expectDefined(page.querySelector<HTMLTextAreaElement>("textarea"), "composer");
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await settle(page);
}

function message(page: NewSessionElement): string {
  return page.querySelector<HTMLTextAreaElement>(".new-session-page__message")?.value ?? "";
}

function detail<T extends Element = HTMLElement>(page: NewSessionElement, selector = "") {
  return page.querySelector<T>(`openclaw-chat-detail-panel${selector && ` ${selector}`}`);
}

function mockDictation() {
  let active = false;
  vi.spyOn(DirectDictationControl.prototype, "active", "get").mockImplementation(() => active);
  return (value: boolean) => {
    active = value;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

afterEach(async () => {
  document.querySelectorAll("openclaw-new-session-page").forEach((element) => element.remove());
  // Keyboard intent prefetches custom elements; finish registration before the shared graph resets.
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("new session draft route ownership", () => {
  it.each([false, true])(
    "retires composer frames through detach and reattach (reduced motion: %s)",
    async (reducedMotion) => {
      const matchMedia = window.matchMedia;
      vi.spyOn(window, "matchMedia").mockImplementation((media) => ({
        ...matchMedia(media),
        matches: reducedMotion && media === "(prefers-reduced-motion: reduce)",
      }));

      const framesClock = createFrameClock();
      const frames = framesClock.frames;
      vi.stubGlobal("requestAnimationFrame", framesClock.request);
      vi.stubGlobal("cancelAnimationFrame", framesClock.cancel);
      const page = await mount(routeData("research"));
      const flushFrames = async (timestamp: number) => {
        framesClock.flush(timestamp);
        await settle(page);
      };
      const placeholder = () => page.querySelector<HTMLTextAreaElement>("textarea")?.placeholder;
      const target = t("newSession.messagePlaceholder");
      await flushFrames(0);
      await flushFrames(206);
      expect(placeholder()).toBe(reducedMotion ? target : target.slice(0, 1));
      page.remove();
      await settle(page);
      expect(frames.size).toBe(0);

      document.body.append(page);
      await settle(page);
      await flushFrames(0);
      await flushFrames(206);
      expect(placeholder()).toBe(reducedMotion ? target : target.slice(0, 1));
      await enterMessage(page, "Keep this draft");
      await flushFrames(232);
      expect(placeholder()).toBe(target);
      expect(frames.size).toBe(0);
    },
  );

  it("focuses an opened draft and refocuses without changing its message", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
    expect(document.activeElement).toBe(textarea);
    expect(textarea?.getAttribute("aria-label")).toBe(t("newSession.messagePlaceholder"));
    await enterMessage(page, "Keep this draft; do not submit it");
    const other = document.body.appendChild(document.createElement("button"));
    try {
      other.focus();
      page.focusComposer();
      await settle(page);
      expect(document.activeElement).toBe(textarea);
      expect(message(page)).toBe("Keep this draft; do not submit it");
      page.focusComposer();
      other.focus();
      await settle(page);
      expect(document.activeElement).toBe(other);
      (document.openClawModalLayers ??= new Set()).add(other);
      other.focus();
      page.focusComposer();
      await settle(page);
      expect(document.activeElement).toBe(other);
    } finally {
      document.openClawModalLayers?.delete(other);
      other.remove();
    }
  });

  it.each(["show in composer", "finish dictation", "change route", "disconnect"] as const)(
    "opens pasted text in the shared side panel and clears it on %s",
    async (transition) => {
      const setDictation = transition === "finish dictation" ? mockDictation() : undefined;
      const page = await mount(routeData("research"));
      await enterMessage(page, "Review the attachment");
      const original = "# Original pasted content\n  preserve indentation 漢字 😀\n".repeat(50);
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response(original)),
      );
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { items: [], getData: () => original },
      });
      page.querySelector("textarea")?.dispatchEvent(paste);
      expect(paste.defaultPrevented).toBe(true);
      await settle(page);
      await vi.dynamicImportSettled();
      await expect
        .poll(() => page.querySelector("openclaw-chat-pasted-text .chat-attachment-file__open"))
        .not.toBeNull();
      if (setDictation) {
        setDictation(true);
        await settle(page);
        expect(page.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(true);
      }
      page
        .querySelector<HTMLElement>("openclaw-chat-pasted-text .chat-attachment-file__open")
        ?.click();
      await customElements.whenDefined("openclaw-chat-detail-panel");
      await settle(page);
      await expect.poll(() => detail(page)).not.toBeNull();
      await detail<ChatDetailPanel>(page)?.updateComplete;
      await expect.poll(() => detail(page, "pre")?.textContent).toBe(original);

      if (transition === "finish dictation") {
        const actionButtons = () => [
          ...page.querySelectorAll<HTMLButtonElement>(
            "openclaw-chat-detail-panel .chat-attachment-text-action, openclaw-chat-detail-panel button[aria-label^='Remove']",
          ),
        ];
        expect(actionButtons()).toHaveLength(2);
        expect(actionButtons().every((button) => button.disabled)).toBe(true);
        setDictation?.(false);
        await expect.poll(() => actionButtons().every((button) => !button.disabled)).toBe(true);
      }
      if (transition === "show in composer" || transition === "finish dictation") {
        await enterMessage(page, "Typed while preview is open");
        const show = [
          ...page.querySelectorAll<HTMLButtonElement>("openclaw-chat-detail-panel button"),
        ].find((button) => button.textContent?.trim() === t("chat.attachments.showInTextField"));
        expect(show).toBeDefined();
        show?.click();
        await settle(page);
        expect(message(page)).toBe(`Typed while preview is open\n\n${original}`);
        expect(page.querySelector("openclaw-chat-pasted-text")).toBeNull();
      } else if (transition === "change route") {
        window.history.replaceState({}, "", "/new?agent=main");
        page.data = routeData("main");
        await settle(page);
      } else {
        page.remove();
        await settle(page);
      }
      expect(detail(page)).toBeNull();
    },
  );

  it("connects document typing to the draft without taking a local editor's focus", async () => {
    const page = await mount(routeData("research"));
    const textarea = expectDefined(page.querySelector<HTMLTextAreaElement>("textarea"), "composer");
    for (const [tag, key, redirects] of [
      ["button", "x", true],
      ["button", " ", false],
      ["input", "x", false],
    ] as const) {
      const target = page.appendChild(document.createElement(tag));
      target.focus();
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
      expect(document.activeElement).toBe(redirects ? textarea : target);
    }
  });

  it("retains destination-owned input through settlement and clears it on a different route", async () => {
    const page = await mount(routeData("research"));

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    await settle(page);
    await enterMessage(page, "keep this fast draft");

    page.data = { ...routeData("", "claude"), requestedAgentId: "research" };
    await settle(page);
    expect(message(page)).toBe("keep this fast draft");

    page.data = routeData("research", "claude");
    await settle(page);
    expect(message(page)).toBe("keep this fast draft");
    window.history.replaceState({}, "", "/new?agent=main&catalog=codex");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
  });
});
