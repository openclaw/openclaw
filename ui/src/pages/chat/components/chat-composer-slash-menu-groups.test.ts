import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SLASH_COMMANDS,
  replaceSlashCommands,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import {
  createSlashMenuState,
  handleSlashMenuKeydown,
  renderSlashMenu,
  updateSlashMenu,
  type SlashMenuHost,
  type SlashMenuState,
} from "./chat-composer-slash-menu.ts";

const FIXTURE: SlashCommandDef[] = [
  {
    key: "alpha-a",
    name: "alpha-a",
    description: "First session command.",
    tier: "standard",
    category: "session",
  },
  {
    key: "beta-a",
    name: "beta-a",
    description: "Model command.",
    tier: "standard",
    category: "model",
  },
  {
    key: "alpha-c",
    name: "alpha-c",
    description: "Power session command.",
    tier: "power",
    category: "session",
  },
];

describe("slash-menu bare-slash display order", () => {
  let saved: SlashCommandDef[];
  let container: HTMLElement;
  let menuHost: HTMLElement;
  let textarea: HTMLTextAreaElement;
  let draft: string;
  let state: SlashMenuState;
  let host: SlashMenuHost;

  const renderMenu = () => {
    render(renderSlashMenu(state, host, draft, renderMenu), menuHost);
  };

  const rowNames = () =>
    Array.from(menuHost.querySelectorAll<HTMLElement>(".slash-menu [role='option']")).map(
      (option) => option.querySelector(".slash-menu-name")?.textContent?.trim(),
    );

  const activeRowName = () => {
    const active = menuHost.querySelectorAll<HTMLElement>(
      ".slash-menu [role='option'][aria-selected='true']",
    );
    expect(active.length).toBe(1);
    return active[0]?.querySelector(".slash-menu-name")?.textContent?.trim();
  };

  const typeDraft = (value: string) => {
    textarea.value = value;
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const pressKey = (key: string) => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  };

  beforeEach(() => {
    saved = [...SLASH_COMMANDS];
    replaceSlashCommands(FIXTURE);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    container = document.createElement("div");
    textarea = document.createElement("textarea");
    menuHost = document.createElement("div");
    container.append(textarea, menuHost);
    document.body.append(container);
    draft = "/";
    state = createSlashMenuState();
    host = {
      paneId: "order-test",
      getDraft: () => draft,
      commitDraft: (next) => {
        draft = next;
        textarea.value = next;
      },
      getTextarea: () => textarea,
      resolveArgOptions: () => [],
      runCommand: () => undefined,
      canRun: () => true,
    };
    textarea.addEventListener("input", () => {
      updateSlashMenu(textarea.value, state, host, renderMenu);
      renderMenu();
    });
    textarea.addEventListener("keydown", (event: KeyboardEvent) => {
      handleSlashMenuKeydown(event, state, host, renderMenu);
      renderMenu();
    });
    typeDraft("/");
  });

  afterEach(() => {
    replaceSlashCommands(saved);
    vi.unstubAllGlobals();
    container.remove();
  });

  it("renders bare-/ category runs together", () => {
    expect(rowNames()).toEqual(["/alpha-a", "/alpha-c", "/beta-a"]);
    expect(activeRowName()).toBe("/alpha-a");
  });

  it("moves ArrowDown through displayed rows without jumping groups", () => {
    pressKey("ArrowDown");
    expect(activeRowName()).toBe("/alpha-c");
    pressKey("ArrowDown");
    expect(activeRowName()).toBe("/beta-a");
    pressKey("ArrowDown");
    expect(activeRowName()).toBe("/alpha-a");
  });

  it("moves ArrowUp from the first row to the last displayed row", () => {
    pressKey("ArrowUp");
    expect(activeRowName()).toBe("/beta-a");
  });

  it("selects the highlighted regrouped row on Enter", () => {
    pressKey("ArrowDown");
    pressKey("ArrowDown");
    expect(activeRowName()).toBe("/beta-a");
    pressKey("Enter");
    expect(draft).toBe("/beta-a ");
    expect(menuHost.querySelector(".slash-menu")).toBeNull();
  });

  it("keeps filtered drafts in ranked order", () => {
    typeDraft("/beta");
    expect(rowNames()).toEqual(["/beta-a"]);
    expect(activeRowName()).toBe("/beta-a");
  });
});
