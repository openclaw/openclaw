/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_PALETTE_TARGET_EVENT } from "../components/command-palette-contract.ts";
import {
  CHAT_HISTORY_RECOVERY_CHANGED_EVENT,
  CHAT_PANE_LIFECYCLE_CHANGED_EVENT,
} from "../pages/chat/chat-history-events.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { NATIVE_HISTORY_STATE_EVENT } from "./native-web-chrome.ts";

afterEach(resetAppHostTestGlobals);

describe("OpenClaw shell event lifecycle", () => {
  it("refreshes the existing connection indicator for recovery and removed panes only while mounted", () => {
    const shell = createShellOwner();
    shell.connect();
    const update = vi.spyOn(shell, "invalidate");
    try {
      for (const type of [CHAT_HISTORY_RECOVERY_CHANGED_EVENT, CHAT_PANE_LIFECYCLE_CHANGED_EVENT]) {
        update.mockClear();
        shell.element.dispatchEvent(new Event(type));
        expect(update).toHaveBeenCalledOnce();
      }
      shell.disconnect();
      update.mockClear();
      shell.element.dispatchEvent(new Event(CHAT_HISTORY_RECOVERY_CHANGED_EVENT));
      expect(update).not.toHaveBeenCalled();
    } finally {
      shell.disconnect();
      update.mockRestore();
    }
  });
  it("retires host, window, and document actions on disconnect and reconnects once", () => {
    const shell = createShellOwner();
    const navigate = vi.spyOn(shell, "navigate").mockImplementation(() => {});
    const onSlashCommand = vi.fn();
    const target = { owner: shell.element, onSlashCommand };
    const history = { canGoBack: true, canGoForward: false };
    const dispatchActions = () => {
      shell.element.dispatchEvent(
        new CustomEvent(COMMAND_PALETTE_TARGET_EVENT, { detail: target }),
      );
      window.dispatchEvent(new CustomEvent(NATIVE_HISTORY_STATE_EVENT, { detail: history }));
      document.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Comma", key: ",", ctrlKey: true, shiftKey: true }),
      );
    };

    try {
      for (let connection = 1; connection <= 2; connection += 1) {
        shell.connect();
        dispatchActions();
        expect(shell.commandPaletteTarget).toBe(target);
        expect(shell.nativeHistoryState).toBe(history);
        expect(navigate).toHaveBeenCalledTimes(connection);
        expect(navigate).toHaveBeenLastCalledWith("appearance");

        shell.disconnect();
        shell.commandPaletteTarget = undefined;
        shell.nativeHistoryState = { canGoBack: false, canGoForward: false };
        dispatchActions();
        expect(shell.commandPaletteTarget).toBeUndefined();
        expect(shell.nativeHistoryState.canGoBack).toBe(false);
        expect(navigate).toHaveBeenCalledTimes(connection);
      }
    } finally {
      shell.disconnect();
      navigate.mockRestore();
    }
  });
});
