/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";
import type { CommandPalette } from "./command-palette.ts";

describe("CommandPalette current-session commands", () => {
  let restoreDialogPolyfill: () => void;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function sessionCommandsFixture(palette: CommandPalette) {
    // The run receipt records palette custody: commands start after focus returns.
    const runs: Array<{ kind: string; open: boolean; modal: boolean }> = [];
    palette.sessionCommands = {
      list: () => [
        { kind: "rename", label: "Rename session", icon: "edit" },
        { kind: "toggle-archived", label: "Archive session", icon: "archive" },
      ],
      run: (kind) =>
        runs.push({
          kind,
          open: palette.isOpen,
          modal: palette.querySelector("openclaw-modal-dialog") !== null,
        }),
    };
    return runs;
  }

  function optionLabels(palette: CommandPalette) {
    return [...palette.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
      option.textContent?.replace(/\s+/g, " ").trim(),
    );
  }

  it("runs a current-session command after the palette closes", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => createSessionResult("agent:main:notes", "Archive notes")),
      ),
    );
    const runs = sessionCommandsFixture(palette);

    await enterQuery(palette, "archive");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(findPaletteOption(palette, "Archive notes")).toBeDefined());

    // Typed verbs name an action: matching commands lead the session results.
    expect(optionLabels(palette)[0]).toBe("Archive session");
    expect(palette.textContent).toContain("Current session");
    findPaletteOption(palette, "Archive session", true)?.click();
    expect(runs).toEqual([]);
    await palette.updateComplete;

    expect(runs).toEqual([{ kind: "toggle-archived", open: false, modal: false }]);
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(palette.onNavigate).not.toHaveBeenCalled();
  });

  it("selects a matching current-session command with Enter", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => null),
      ),
    );
    const runs = sessionCommandsFixture(palette);

    await enterQuery(palette, "rename");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    palette
      .querySelector<HTMLTextAreaElement>(".cmd-palette__input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await palette.updateComplete;

    expect(runs).toEqual([{ kind: "rename", open: false, modal: false }]);
  });

  it("lists current-session commands after navigation before a query", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => null),
      ),
    );
    sessionCommandsFixture(palette);

    palette.openPalette();
    await palette.updateComplete;

    const labels = optionLabels(palette);
    // Enter on an empty palette keeps opening New Session.
    expect(labels[0]).toBe("New session");
    expect(labels.slice(-2)).toEqual(["Rename session", "Archive session"]);
    expect(palette.textContent).toContain("Current session");
  });

  it("omits current-session commands without a chat target", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(
      createContext(
        gateway,
        vi.fn(async () => null),
      ),
    );
    palette.sessionCommands = null;

    await enterQuery(palette, "archive");
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;

    expect(findPaletteOption(palette, "Archive session")).toBeUndefined();
    expect(palette.textContent).not.toContain("Current session");
  });
});
