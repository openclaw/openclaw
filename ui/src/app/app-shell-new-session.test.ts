/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./app-host.ts";
import { resetAppHostTestGlobals, type ShellKeyboardState } from "./app-host.test-support.ts";
import type { ApplicationContext } from "./context.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetAppHostTestGlobals();
});

describe("new-session keyboard shortcut", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the selected agent's draft from an editor on %s",
    (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
      shell.runtime = {
        context: {
          navigate,
          agentSelection: { state: { selectedId: "research" } },
          gateway: {
            snapshot: {
              client: {},
              phase: "connected",
              hello: {
                auth: { role: "operator", scopes: ["operator.write"] },
                features: { methods: ["sessions.create"] },
              },
            },
          },
        } as unknown as ApplicationContext,
      };
      const editor = document.createElement("textarea");
      editor.value = "Keep this unsent draft";
      editor.addEventListener("keydown", shell.handleDocumentKeydown);
      const modifiers =
        platform === "MacIntel" ? { metaKey: true, altKey: true } : { ctrlKey: true, altKey: true };
      for (const init of [
        { key: "n", code: "KeyN" },
        ...(platform === "MacIntel"
          ? [
              { key: "˜", code: "KeyN" },
              { key: "n", code: "KeyN", modifierAltGraph: true },
              { key: "˜", code: "KeyN", modifierAltGraph: true },
            ]
          : []),
      ]) {
        const event = new KeyboardEvent("keydown", { ...init, ...modifiers, cancelable: true });
        editor.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", {
          search: "?agent=research",
        });
        navigate.mockClear();
      }
      for (const init of [
        { shiftKey: true },
        { altKey: false },
        { metaKey: false, ctrlKey: false },
        { key: "Dead" },
        ...(platform === "MacIntel"
          ? [{ modifierAltGraph: true, metaKey: false }]
          : [{ modifierAltGraph: true }]),
        ...(platform === "MacIntel" ? [] : [{ key: "ñ" }]),
        { metaKey: true, ctrlKey: true },
        { metaKey: !modifiers.metaKey, ctrlKey: !modifiers.ctrlKey },
        { isComposing: true },
        { keyCode: 229 },
      ]) {
        const event = new KeyboardEvent("keydown", {
          key: "n",
          code: "KeyN",
          ...modifiers,
          ...init,
          cancelable: true,
        });
        editor.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      const repeated = new KeyboardEvent("keydown", {
        key: "n",
        ...modifiers,
        repeat: true,
        cancelable: true,
      });
      editor.dispatchEvent(repeated);
      expect(repeated.defaultPrevented).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
      expect(editor.value).toBe("Keep this unsent draft");
    },
  );
});
