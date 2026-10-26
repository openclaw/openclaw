import { afterEach, describe, expect, it, vi } from "vitest";
import { createOverlay } from "../../components/overlay-lifecycle.ts";
import { registerModalSurface } from "../../components/overlay-registry.ts";
import { t } from "../../i18n/index.ts";
import { createFrameClock } from "../../test-helpers/animation-frame-clock.ts";
import { createMediaQueryList } from "../../test-helpers/media-query.ts";
import * as attachmentInputs from "../chat/components/chat-attachment-inputs.tsx";
import type { ChatDetailPanel } from "../chat/components/chat-sidebar-view-types.ts";
import { DirectDictationControl } from "../chat/composer-direct-dictation.ts";
import { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { NewSessionRouteData } from "./location.ts";
import "./new-session-page-entry.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { NewSessionPageOwner } from "./new-session-page-owner.ts";

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
  const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
  expect(textarea).not.toBeNull();
  if (!textarea) {
    return;
  }
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await settle(page);
}

function message(page: NewSessionElement): string {
  return page.querySelector<HTMLTextAreaElement>(".new-session-page__message")?.value ?? "";
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
  it("prepares composer options once per published typing revision without replacing the input", async () => {
    const prepare = vi.spyOn(NewSessionPageOwner.prototype, "composerOptions");
    const projectRecents = vi.spyOn(DraftPlaceBrowser.prototype, "resolveProjectRecents");
    const renderModels = vi.spyOn(NewSessionModelControl.prototype, "renderProps");
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>("textarea")!;
    await enterMessage(page, "warmup");
    for (const text of ["h", "he", "hello"]) {
      prepare.mockClear();
      projectRecents.mockClear();
      renderModels.mockClear();
      await enterMessage(page, text);
      expect(prepare).toHaveBeenCalledOnce();
      expect(projectRecents.mock.calls.length).toBeLessThanOrEqual(2);
      expect(renderModels).not.toHaveBeenCalled();
      expect(page.querySelector("textarea")).toBe(textarea);
      expect(textarea.value).toBe(text);
    }
  });

  it("keeps retained attachment callbacks connected to live draft and lock state", async () => {
    const inputs = vi.spyOn(attachmentInputs, "ChatAttachmentInputs");
    let dictating = false;
    vi.spyOn(DirectDictationControl.prototype, "active", "get").mockImplementation(() => dictating);
    const page = await mount(routeData("research"));
    await enterMessage(page, "initial draft");
    const retained = inputs.mock.calls.at(-1)?.[0];
    expect(retained).toBeDefined();
    expect(retained?.getDraft?.()).toBe("initial draft");
    await enterMessage(page, "later draft");
    expect(retained?.getDraft?.()).toBe("later draft");
    dictating = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(page);
    expect(retained?.disabled).toBe(true);
  });

  it.each([false, true])(
    "retires composer frames through detach and reattach (reduced motion: %s)",
    async (reducedMotion) => {
      vi.stubGlobal("matchMedia", (media: string) =>
        createMediaQueryList(media, reducedMotion && media === "(prefers-reduced-motion: reduce)"),
      );

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
      let dictating = false;
      if (transition === "finish dictation") {
        vi.spyOn(DirectDictationControl.prototype, "active", "get").mockImplementation(
          () => dictating,
        );
      }
      const page = await mount(routeData("research"));
      await enterMessage(page, "Review the attachment");
      const original = "# Original pasted content\n  preserve indentation 漢字 😀\n".repeat(50);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(original));
      vi.stubGlobal("fetch", fetchMock);
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
      if (transition === "finish dictation") {
        dictating = true;
        document.dispatchEvent(new Event("visibilitychange"));
        await settle(page);
        expect(page.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(true);
      }
      page
        .querySelector<HTMLElement>("openclaw-chat-pasted-text .chat-attachment-file__open")
        ?.click();
      await customElements.whenDefined("openclaw-chat-detail-panel");
      await settle(page);
      await expect.poll(() => page.querySelector("openclaw-chat-detail-panel")).not.toBeNull();
      await page.querySelector<ChatDetailPanel>("openclaw-chat-detail-panel")?.updateComplete;
      await expect
        .poll(() => {
          const source = page
            .querySelector<HTMLAnchorElement>("openclaw-chat-detail-panel a[download]")
            ?.getAttribute("href");
          return Boolean(source && fetchMock.mock.calls.some(([url]) => url === source));
        })
        .toBe(true);
      await expect
        .poll(() => page.querySelector("openclaw-chat-detail-panel pre")?.textContent)
        .toBe(original);

      if (transition === "finish dictation") {
        const actionButtons = () => [
          ...page.querySelectorAll<HTMLButtonElement>(
            "openclaw-chat-detail-panel .chat-attachment-text-action, openclaw-chat-detail-panel button[aria-label^='Remove']",
          ),
        ];
        expect(actionButtons()).toHaveLength(2);
        expect(actionButtons().every((button) => button.disabled)).toBe(true);
        dictating = false;
        document.dispatchEvent(new Event("visibilitychange"));
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
      expect(page.querySelector("openclaw-chat-detail-panel")).toBeNull();
    },
  );

  it("routes every focus-surface and key-class pair by the shared contract", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
    expect(textarea).not.toBeNull();
    if (!textarea) {
      return;
    }
    const keys = ["x", " ", "Enter", "ArrowDown", "Escape"] as const;
    type Destination = "composer" | "element" | "overlay" | "nothing";
    type Surface = {
      name: string;
      targets: HTMLElement[];
      expected: readonly Destination[];
      openDialog?: boolean;
      openMenu?: boolean;
    };
    const append = <T extends HTMLElement>(element: T): T => page.appendChild(element);
    const main = append(document.createElement("main"));
    main.tabIndex = -1;
    const button = append(document.createElement("button"));
    const link = append(document.createElement("a"));
    link.href = "#target";
    const menu = append(document.createElement("div"));
    menu.setAttribute("role", "menu");
    menu.popover = "manual";
    const menuOwner = createOverlay("new-session-routing-test", undefined, {
      dismissOutsideFocus: false,
    });
    menuOwner.bindSurface(menu);
    const menuItem = menu.appendChild(document.createElement("button"));
    menuItem.setAttribute("role", "menuitemradio");
    menuItem.tabIndex = -1;
    const dialog = append(document.createElement("dialog"));
    const releaseDialog = registerModalSurface(dialog);
    dialog.open = true;
    const dialogButton = dialog.appendChild(document.createElement("button"));
    const details = append(document.createElement("details"));
    details.open = true;
    const summary = details.appendChild(document.createElement("summary"));
    const input = append(document.createElement("input"));
    const editable = append(document.createElement("div"));
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    const element = ["element", "element", "element", "element", "element"] as const;
    const overlay = ["overlay", "overlay", "overlay", "overlay", "overlay"] as const;
    const routing: Surface[] = [
      {
        name: "main",
        targets: [main],
        expected: ["composer", "composer", "nothing", "nothing", "nothing"],
      },
      { name: "composer", targets: [textarea], expected: element },
      {
        name: "button/link",
        targets: [button, link],
        expected: ["composer", "element", "element", "nothing", "nothing"],
      },
      {
        name: "menuitem",
        targets: [menuItem],
        expected: ["composer", "overlay", "overlay", "overlay", "overlay"],
        openMenu: true,
      },
      {
        name: "open native menu",
        targets: [main],
        expected: ["composer", "overlay", "overlay", "overlay", "overlay"],
        openMenu: true,
      },
      { name: "dialog", targets: [dialogButton], expected: overlay, openDialog: true },
      {
        name: "details/summary",
        targets: [summary],
        expected: ["composer", "element", "element", "nothing", "nothing"],
      },
      { name: "input/contenteditable", targets: [input, editable], expected: element },
    ];

    try {
      for (const row of routing) {
        for (const target of row.targets) {
          for (const [index, key] of keys.entries()) {
            menuOwner.request(row.openMenu === true);
            dialog.open = row.openDialog === true;
            target.focus();
            target.dispatchEvent(
              new KeyboardEvent("keydown", { key, bubbles: true, composed: true }),
            );
            const destination = row.expected[index];
            if (destination === "composer") {
              expect(document.activeElement, `${row.name} / ${key} -> composer`).toBe(textarea);
            } else if (destination === "overlay") {
              expect(document.activeElement, `${row.name} / ${key} -> overlay`).not.toBe(textarea);
            } else {
              expect(document.activeElement, `${row.name} / ${key} -> ${destination}`).toBe(target);
            }
          }
        }
      }
    } finally {
      menuOwner.dispose();
      releaseDialog();
    }
  });

  it("keeps destination input through pending data, settlement, and agent resolution", async () => {
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
  });

  it("clears a draft when a different route settles without destination-owned input", async () => {
    const page = await mount(routeData("research", "claude"));
    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    await enterMessage(page, "route-owned draft");

    window.history.replaceState({}, "", "/new?agent=main&catalog=codex");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
  });
});
