/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_PALETTE_TARGET_EVENT } from "../components/command-palette-contract.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import "./app-host.ts";
import type { ShellChromeHost } from "./app-shell-chrome.ts";
import { NATIVE_HISTORY_STATE_EVENT } from "./native-web-chrome.ts";

type ShellLifecycle = {
  connectedCallback(): void;
  disconnectedCallback(): void;
};

afterEach(resetAppHostTestGlobals);

describe("OpenClaw shell event lifecycle", () => {
  it("retires host, window, and document actions on disconnect and reconnects once", () => {
    const shell = document.createElement("openclaw-app-shell") as ShellChromeHost & ShellLifecycle;
    const navigate = vi.spyOn(shell, "navigate").mockImplementation(() => {});
    const onSlashCommand = vi.fn();
    const target = { owner: shell, onSlashCommand, sessionCommands: null };
    const history = { canGoBack: true, canGoForward: false };
    const dispatchActions = () => {
      shell.dispatchEvent(new CustomEvent(COMMAND_PALETTE_TARGET_EVENT, { detail: target }));
      window.dispatchEvent(new CustomEvent(NATIVE_HISTORY_STATE_EVENT, { detail: history }));
      document.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Comma", key: ",", ctrlKey: true, shiftKey: true }),
      );
    };

    try {
      for (let connection = 1; connection <= 2; connection += 1) {
        shell.connectedCallback();
        dispatchActions();
        expect(shell.commandPaletteTarget).toBe(target);
        expect(shell.nativeHistoryState).toBe(history);
        expect(navigate).toHaveBeenCalledTimes(connection);
        expect(navigate).toHaveBeenLastCalledWith("appearance");

        shell.disconnectedCallback();
        shell.commandPaletteTarget = undefined;
        shell.nativeHistoryState = { canGoBack: false, canGoForward: false };
        dispatchActions();
        expect(shell.commandPaletteTarget).toBeUndefined();
        expect(shell.nativeHistoryState.canGoBack).toBe(false);
        expect(navigate).toHaveBeenCalledTimes(connection);
      }
    } finally {
      shell.disconnectedCallback();
      navigate.mockRestore();
    }
  });

  it("offers session commands only from the connected palette target", () => {
    const shell = document.createElement("openclaw-app-shell") as ShellChromeHost &
      ShellLifecycle & { commandPaletteSessionCommands(): unknown };
    const owner = document.createElement("div");
    const sessionCommands = { list: () => [], run: vi.fn() };
    const announce = (active: boolean) =>
      shell.dispatchEvent(
        new CustomEvent(COMMAND_PALETTE_TARGET_EVENT, {
          detail: {
            owner,
            onSlashCommand: active ? vi.fn() : null,
            sessionCommands: active ? sessionCommands : null,
          },
        }),
      );
    document.body.append(owner);
    shell.connectedCallback();
    try {
      announce(true);
      expect(shell.commandPaletteSessionCommands()).toBe(sessionCommands);
      owner.remove();
      expect(shell.commandPaletteSessionCommands()).toBeNull();
      document.body.append(owner);
      announce(false);
      expect(shell.commandPaletteSessionCommands()).toBeNull();
    } finally {
      shell.disconnectedCallback();
      owner.remove();
    }
  });
});
