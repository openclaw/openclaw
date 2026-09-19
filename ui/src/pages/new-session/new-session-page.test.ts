import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { NewSessionDictationControl } from "./composer-dictation-control.ts";
import type { NewSessionRouteData } from "./location.ts";
import "./new-session-page-entry.ts";

type NewSessionElement = HTMLElement & {
  data: NewSessionRouteData | undefined;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

function routeData(agentId: string, catalogId = ""): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId,
    model: "",
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

afterEach(() => {
  document.querySelectorAll("openclaw-new-session-page").forEach((element) => element.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("new session draft route ownership", () => {
  it.each(["show in composer", "finish dictation", "change route", "disconnect"] as const)(
    "opens pasted text in the shared side panel and clears it on %s",
    async (transition) => {
      let dictating = false;
      if (transition === "finish dictation") {
        vi.spyOn(NewSessionDictationControl.prototype, "active", "get").mockImplementation(
          () => dictating,
        );
      }
      const page = await mount(routeData("research"));
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
      await expect
        .poll(() => page.querySelector("openclaw-chat-pasted-text [role=button]"))
        .not.toBeNull();
      if (transition === "finish dictation") {
        dictating = true;
        page.requestUpdate();
        await settle(page);
        expect(page.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(true);
      }
      page.querySelector<HTMLElement>("openclaw-chat-pasted-text [role=button]")?.click();
      await expect.poll(() => page.querySelector("openclaw-chat-detail-panel")).not.toBeNull();
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
        page.requestUpdate();
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
      openDropdown?: boolean;
    };
    const append = <T extends HTMLElement>(element: T): T => page.appendChild(element);
    const main = append(document.createElement("main"));
    main.tabIndex = -1;
    const button = append(document.createElement("button"));
    const link = append(document.createElement("a"));
    link.href = "#target";
    const menu = append(document.createElement("wa-dropdown")) as HTMLElement & { open: boolean };
    const menuItem = menu.appendChild(document.createElement("wa-dropdown-item"));
    menuItem.setAttribute("role", "menuitemradio");
    menuItem.tabIndex = -1;
    const dialog = append(document.createElement("dialog"));
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
        openDropdown: true,
      },
      {
        name: "open wa-dropdown",
        targets: [main],
        expected: ["composer", "overlay", "overlay", "overlay", "overlay"],
        openDropdown: true,
      },
      { name: "dialog", targets: [dialogButton], expected: overlay, openDialog: true },
      {
        name: "details/summary",
        targets: [summary],
        expected: ["composer", "element", "element", "nothing", "nothing"],
      },
      { name: "input/contenteditable", targets: [input, editable], expected: element },
    ];

    for (const row of routing) {
      for (const target of row.targets) {
        for (const [index, key] of keys.entries()) {
          menu.open = row.openDropdown === true;
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
  });

  it("leaves shortcuts, composition, and other form controls alone", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");

    for (const init of [
      { key: "x", ctrlKey: true },
      { key: "x", metaKey: true },
      { key: "Tab" },
      { key: "Escape" },
      { key: "Process", isComposing: true },
    ]) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { ...init, bubbles: true, composed: true }),
      );
      expect(document.activeElement).not.toBe(textarea);
    }

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    for (const control of [
      document.createElement("input"),
      document.createElement("select"),
      document.createElement("textarea"),
      editable,
    ]) {
      page.append(control);
      control.focus();
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }),
      );
      expect(document.activeElement).toBe(control);
    }
  });

  it("labels the message input independently of its placeholder", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");

    expect(textarea?.getAttribute("aria-label")).toBe(t("newSession.messagePlaceholder"));
  });

  it("clears source draft state when destination data is still pending", async () => {
    const page = await mount(routeData("research"));
    window.history.replaceState({}, "", "/new?agent=research");
    await enterMessage(page, "source draft");

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
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
