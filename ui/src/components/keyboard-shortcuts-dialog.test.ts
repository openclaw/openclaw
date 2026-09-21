/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellNewSessionHost } from "../app/app-shell-new-session.ts";
import type { ApplicationContext } from "../app/context.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import "./keyboard-shortcuts-dialog.ts";

type KeyboardShortcutsTestDialog = HTMLElement & {
  isOpen: boolean;
  sendShortcut: "enter" | "modifier-enter";
  toggle(): void;
  newSessionHost?: ShellNewSessionHost;
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("keyboard shortcuts dialog", () => {
  it.each([
    { platform: "Win32", modifier: "Ctrl", shift: "Shift", alt: "Alt", enter: "Enter" },
    { platform: "MacIntel", modifier: "⌘", shift: "⇧", alt: "⌥", enter: "⏎" },
  ])(
    "renders grouped shortcut chips and send preferences on $platform",
    async ({ platform, modifier, shift, alt, enter }) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const dialog = document.body.appendChild(
        document.createElement("openclaw-keyboard-shortcuts-dialog") as KeyboardShortcutsTestDialog,
      );
      dialog.toggle();
      await dialog.updateComplete;

      expect(dialog.shadowRoot?.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
      expect(
        Array.from(
          dialog.shadowRoot?.querySelectorAll("h3") ?? [],
          (heading) => heading.textContent,
        ),
      ).toEqual(["General", "Chat", "Panels", "Sidebar", "Image viewer", "Approvals"]);
      for (const [label, key] of [
        ["Open New Session", "O"],
        ["Archive current session", "A"],
      ] as const) {
        const row = Array.from(dialog.shadowRoot?.querySelectorAll(".shortcut-row") ?? []).find(
          (candidate) => candidate.textContent?.includes(label),
        );
        expect(Array.from(row?.querySelectorAll("kbd") ?? [], (kbd) => kbd.textContent)).toEqual([
          modifier,
          shift,
          key,
        ]);
      }
      const selectionRow = Array.from(
        dialog.shadowRoot?.querySelectorAll(".shortcut-row") ?? [],
      ).find((row) => row.textContent?.includes("Select multiple sessions"));
      expect(
        Array.from(selectionRow?.querySelectorAll("kbd") ?? [], (key) => key.textContent),
      ).toEqual([alt, "Click"]);

      const sendRow = () =>
        Array.from(dialog.shadowRoot?.querySelectorAll(".shortcut-row") ?? []).find((row) =>
          row.textContent?.includes("Send message"),
        );
      expect(
        Array.from(sendRow()?.querySelectorAll("kbd") ?? [], (key) => key.textContent),
      ).toEqual([enter]);

      dialog.sendShortcut = "modifier-enter";
      await dialog.updateComplete;

      expect(
        Array.from(sendRow()?.querySelectorAll("kbd") ?? [], (key) => key.textContent),
      ).toEqual([modifier, enter]);
      dialog.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-label='Close']")?.click();
      await dialog.updateComplete;
      expect(dialog.isOpen).toBe(false);
      expect(dialog.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "hands New Session off only after releasing the help modal on %s",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const restoreDialog = installDialogPolyfill();
      const dialog = document.body.appendChild(
        document.createElement("openclaw-keyboard-shortcuts-dialog") as KeyboardShortcutsTestDialog,
      );
      const openNewSession = vi.fn(() => {
        expect(document.openClawModalLayers?.size ?? 0).toBe(0);
      });
      const context = {
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
        agentSelection: { state: { selectedId: "research" } },
      };
      const sessionHost = document.body.appendChild(
        Object.assign(document.createElement("div"), {
          context: context as unknown as ApplicationContext,
          onboardingMode: false,
          pendingNativeNewSession: false,
          openNewSession,
        }),
      );
      dialog.newSessionHost = sessionHost;
      const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      try {
        dialog.toggle();
        await dialog.updateComplete;
        const { dialog: modal } = await getRenderedModalDialog(dialog.shadowRoot!);
        const key = (init: KeyboardEventInit) => {
          const event = new KeyboardEvent("keydown", {
            ...modifier,
            key: "O",
            code: "KeyO",
            shiftKey: true,
            bubbles: true,
            composed: true,
            cancelable: true,
            ...init,
          });
          modal.dispatchEvent(event);
          return event;
        };
        for (const init of [
          { repeat: true },
          { isComposing: true },
          { keyCode: 229 },
          { altKey: true },
          { key: "A", code: "KeyA" },
        ]) {
          expect(key(init).defaultPrevented).toBe(false);
        }
        const otherModal = document.body.appendChild(
          document.createElement("openclaw-modal-dialog"),
        );
        expect(key({}).defaultPrevented).toBe(false);
        expect(dialog.isOpen).toBe(true);
        otherModal.remove();
        dialog.newSessionHost = undefined;
        expect(key({}).defaultPrevented).toBe(false);
        expect(dialog.isOpen).toBe(true);
        dialog.newSessionHost = sessionHost;
        context.gateway.snapshot.hello.auth.scopes = ["operator.read"];
        expect(key({}).defaultPrevented).toBe(false);
        expect(dialog.isOpen).toBe(true);
        context.gateway.snapshot.hello.auth.scopes = ["operator.write"];
        expect(openNewSession).not.toHaveBeenCalled();
        expect(key({}).defaultPrevented).toBe(true);
        await dialog.updateComplete;
        expect(dialog.isOpen).toBe(false);
        expect(openNewSession).toHaveBeenCalledExactlyOnceWith("research");
      } finally {
        dialog.remove();
        sessionHost.remove();
        restoreDialog();
      }
    },
  );

  it("closes when the modal dispatches its Escape cancellation", async () => {
    const dialog = document.body.appendChild(
      document.createElement("openclaw-keyboard-shortcuts-dialog") as KeyboardShortcutsTestDialog,
    );
    dialog.toggle();
    await dialog.updateComplete;

    dialog.shadowRoot
      ?.querySelector("openclaw-modal-dialog")
      ?.dispatchEvent(new CustomEvent("modal-cancel"));
    await dialog.updateComplete;

    expect(dialog.isOpen).toBe(false);
  });
});
