/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFallbackSlashCommands,
  findInlineSlashCompletion,
  replaceSlashCommands,
} from "../../../lib/chat/commands.ts";
import {
  createSlashMenuState,
  handleInlineSlashArgKeydown,
  handleSlashMenuKeydown,
  renderSlashMenu,
  resetSlashMenuState,
  updateSlashMenu,
  type SlashMenuHost,
} from "./chat-composer-slash-menu.ts";

function fixture(value: string, caret = value.length, overrides: Partial<SlashMenuHost> = {}) {
  const container = document.createElement("div");
  const textarea = document.createElement("textarea");
  container.append(textarea);
  const menu = document.createElement("div");
  container.append(menu);
  document.body.append(container);
  textarea.value = value;
  textarea.selectionStart = textarea.selectionEnd = caret;
  let draft = value;
  const state = createSlashMenuState();
  const host: SlashMenuHost = {
    paneId: "precedence-test",
    getDraft: () => draft,
    getTextarea: () => textarea,
    commitDraft: vi.fn((next) => {
      draft = next;
    }),
    resolveArgOptions: (command) => command.argOptions ?? [],
    canRun: () => true,
    runCommand: vi.fn(),
    runInlineCommand: vi.fn(),
    ...overrides,
  };
  const requestUpdate = () =>
    render(html`${renderSlashMenu(state, host, draft, requestUpdate)}`, menu);
  textarea.addEventListener("input", () => {
    draft = textarea.value;
    updateSlashMenu(draft, state, host, requestUpdate);
  });
  textarea.addEventListener("keydown", (event) => {
    handleSlashMenuKeydown(event, state, host, requestUpdate);
  });
  const input = (next = value, position = next.length) => {
    textarea.value = next;
    textarea.selectionStart = textarea.selectionEnd = position;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  };
  const key = (pressedKey: string) => {
    const event = new KeyboardEvent("keydown", {
      key: pressedKey,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    return event;
  };
  input(value, caret);
  return { container, textarea, state, host, requestUpdate, input, key };
}

beforeEach(() => replaceSlashCommands(buildFallbackSlashCommands()));
afterEach(() => {
  document.body.replaceChildren();
  replaceSlashCommands(buildFallbackSlashCommands());
});

describe("caret-local slash menu precedence", () => {
  it.each([
    ["/help /statu", 12],
    ["/name Draft /statu", 17],
    ["/help /status after", 12],
    ["/thinking please", 4],
  ])("offers the caret token instead of the leading argument tail in %s", (value, caret) => {
    const view = fixture(value, caret);
    const completion = findInlineSlashCompletion(value, caret);
    expect(completion?.inline).toBe(true);
    expect(view.state.slashMenuOpen).toBe(true);
    expect(view.state.slashMenuMode).toBe("command");
    expect(view.state.slashMenuCompletion).toEqual(completion);
    expect(view.state.slashMenuItems.map((command) => command.name)).toContain(
      value.startsWith("/thinking") ? "think" : "status",
    );
    expect(view.container.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it.each([
    ["/help /statu", "/help "],
    ["/name Draft /statu", "/name Draft "],
    ["/help /status after", "/help after"],
  ])("dispatches only the selected inline command and retains %s", async (value, remaining) => {
    const caret = value.indexOf("/sta") + 6;
    const view = fixture(value, caret);
    const option = view.container.querySelector<HTMLElement>('[id$="slash-option-command-status"]');
    expect(option).not.toBeNull();
    option?.click();
    await Promise.resolve();
    expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/status");
    expect(view.host.runCommand).not.toHaveBeenCalled();
    expect(view.host.getDraft()).toBe(remaining);
    expect(view.textarea.value).toBe(remaining);
    expect(view.state.slashMenuOpen).toBe(false);
  });

  it("keeps Tab completion separate from Enter acceptance", () => {
    const view = fixture("/help /statu");
    expect(view.key("Tab").defaultPrevented).toBe(true);
    expect(view.textarea.value).toBe("/help /status ");
    expect(view.host.runInlineCommand).not.toHaveBeenCalled();
    view.input("/help /statu");
    expect(view.key("Enter").defaultPrevented).toBe(true);
    expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/status");
    expect(view.textarea.value).toBe("/help ");
  });

  it("retains leading finite arguments and their ordinary dispatch", () => {
    const view = fixture("/verbose o");
    expect(view.state.slashMenuMode).toBe("args");
    expect(view.state.slashMenuArgItems).toEqual(["on", "off"]);
    expect(view.state.slashMenuCompletion).toBeNull();
    view.key("Enter");
    expect(view.host.commitDraft).toHaveBeenLastCalledWith("/verbose on");
    expect(view.host.runCommand).toHaveBeenCalledOnce();
    expect(view.host.runInlineCommand).not.toHaveBeenCalled();
  });

  it("keeps finite arguments attached to the caret-local command", () => {
    const view = fixture("/help /verbose");
    view.key("Enter");
    expect(view.state.slashMenuMode).toBe("args");
    expect(view.state.slashMenuCompletion?.inline).toBe(true);
    const option = view.container.querySelector<HTMLElement>('[id$="slash-option-arg-verbose-on"]');
    expect(option).not.toBeNull();
    option?.click();
    expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/verbose on");
    expect(view.host.runCommand).not.toHaveBeenCalled();
    expect(view.textarea.value).toBe("/help ");
  });

  it("rechecks inline permission when the rendered option is selected", () => {
    let allowed = true;
    const view = fixture("/help /statu", undefined, { canRun: () => allowed });
    const option = view.container.querySelector<HTMLElement>('[id$="slash-option-command-status"]');
    expect(option).not.toBeNull();
    allowed = false;
    option?.click();
    expect(view.host.runInlineCommand).not.toHaveBeenCalled();
    expect(view.textarea.value).toBe("/help /statu");
  });

  it("keeps skill-only colon completion as a draft reference", () => {
    replaceSlashCommands([
      ...buildFallbackSlashCommands(),
      {
        key: "weather",
        name: "weather",
        description: "Weather skill",
        source: "skill",
        skillModelVisible: true,
      },
    ]);
    const view = fixture("/help /weather:");
    const option = view.container.querySelector<HTMLElement>(
      '[id$="slash-option-command-weather"]',
    );
    expect(option).not.toBeNull();
    option?.click();
    expect(view.textarea.value).toBe("/help $weather ");
    expect(view.host.runInlineCommand).not.toHaveBeenCalled();
    expect(view.host.runCommand).not.toHaveBeenCalled();
  });

  it("retains ordinary goal argument Enter dispatch", () => {
    const view = fixture("/goal stat");
    expect(view.state.slashMenuMode).toBe("args");
    expect(view.state.slashMenuArgItems).toEqual(["status"]);
    view.key("Enter");
    expect(view.host.commitDraft).toHaveBeenLastCalledWith("/goal status");
    expect(view.host.runCommand).toHaveBeenCalledOnce();
  });

  it("retains active inline freeform argument ownership over slash-like text", async () => {
    const view = fixture("Draft /name");
    view.key("Enter");
    await Promise.resolve();
    expect(view.state.slashMenuMode).toBe("freeform-args");
    view.input("Draft /name title /statu");
    expect(view.state.slashMenuMode).toBe("freeform-args");
    expect(view.state.slashMenuOpen).toBe(false);
    expect(view.state.slashMenuCommand?.name).toBe("name");
    expect(
      handleInlineSlashArgKeydown(
        new KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
        view.state,
        view.host,
        view.requestUpdate,
        "enter",
      ),
    ).toBe(true);
    expect(view.host.runInlineCommand).toHaveBeenCalledExactlyOnceWith("/name title /statu");
    expect(view.textarea.value).toBe("Draft ");
  });

  it.each(["/help https://example.com/statu", "/help tmp/statu", "/help //statu"])(
    "does not create a completion for %s",
    (value) => {
      const view = fixture(value);
      expect(view.state.slashMenuOpen).toBe(false);
    },
  );

  it("retains New Session inline dispatch restrictions", () => {
    const view = fixture("/help /statu", undefined, {
      canRun: (inline) => !inline,
      commandFilter: (command) => command.executeLocal !== true,
      runInlineCommand: undefined,
    });
    expect(view.state.slashMenuOpen).toBe(false);
    expect(view.state.slashMenuItems).toEqual([]);
    view.key("Enter");
    expect(view.host.runCommand).not.toHaveBeenCalled();
  });

  it("recomputes caret-local completion after the catalog refresh settles", async () => {
    let resolve!: () => void;
    const refresh = new Promise<void>((done) => {
      resolve = done;
    });
    const refreshCommands = vi.fn(() => refresh);
    const view = fixture("/help /statu", undefined, { refreshCommands });
    expect(view.state.slashCommandRefreshPending).toBe(true);
    view.input("/help /comm");
    resolve();
    await refresh;
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshCommands).toHaveBeenCalledOnce();
    expect(view.state.slashCommandRefreshPending).toBe(false);
    expect(view.state.slashMenuItems.map((command) => command.name)).toContain("commands");
  });

  it("does not reopen a dismissed completion when refresh settles", async () => {
    let resolve!: () => void;
    const refresh = new Promise<void>((done) => {
      resolve = done;
    });
    const view = fixture("/help /statu", undefined, { refreshCommands: () => refresh });
    resetSlashMenuState(view.state);
    resolve();
    await refresh;
    await Promise.resolve();
    await Promise.resolve();
    expect(view.state.slashMenuOpen).toBe(false);
    expect(view.state.slashMenuCompletion).toBeNull();
  });
});
