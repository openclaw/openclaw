/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog.tsx";

let restoreDialog: (() => void) | undefined;
const makeDialog = () => document.body.appendChild(new KeyboardShortcutsDialog.Element());
async function openDialog(dialog = makeDialog()) {
  dialog.toggle();
  await dialog.updateComplete;
  return dialog;
}
function chips(dialog: HTMLElement, label: string) {
  const row = Array.from(dialog.querySelectorAll(".shortcut-row")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  return Array.from(row?.querySelectorAll("kbd") ?? [], (key) => key.textContent?.trim());
}

afterEach(() => {
  document.body.replaceChildren();
  restoreDialog?.();
  restoreDialog = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["Win32", "Ctrl", "Enter"],
  ["MacIntel", "⌘", "⏎"],
])("renders shortcut groups and send preferences: %s", async (platform, modifier, enter) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const dialog = await openDialog();

  expect(dialog.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
  expect(Array.from(dialog.querySelectorAll("h3") ?? [], (heading) => heading.textContent)).toEqual(
    ["General", "Chat", "Panels", "Sidebar", "Image viewer", "Approvals"],
  );
  expect(chips(dialog, "Send message")).toEqual([enter]);

  dialog.sendShortcut = "modifier-enter";
  await dialog.updateComplete;

  expect(chips(dialog, "Send message")).toEqual([modifier, enter]);
  dialog.querySelector<HTMLButtonElement>("button[aria-label='Close']")?.click();
  await dialog.updateComplete;
  expect(dialog.isOpen).toBe(false);
  expect(dialog.querySelector("openclaw-modal-dialog")).toBeNull();
});

it.each(
  ["MacIntel", "Win32", "Linux x86_64"].flatMap((platform) =>
    [false, true].map((native) => ({ platform, native })),
  ),
)(
  "hands off New Session after help closes: $platform/native=$native",
  async ({ platform, native }) => {
    vi.stubGlobal("__OPENCLAW_NATIVE_WEB_CHROME__", native);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    restoreDialog = installDialogPolyfill();
    const dialog = makeDialog();
    const openNewSession = vi.fn(() => {
      expect(document.openClawModalLayers?.size ?? 0).toBe(0);
    });
    const auth = { role: "operator", scopes: ["operator.write"] };
    const hello = { auth, features: { methods: ["sessions.create"] } };
    const context = {
      gateway: { snapshot: { client: {}, phase: "connected", hello } },
      agentSelection: { state: { selectedId: "research" } },
    };
    const sessionHost = document.body.appendChild(
      Object.assign(document.createElement("div"), {
        context: context as unknown as ApplicationContext,
        onboardingMode: false,
        pendingNativeNewSession: false,
        shellNavigation: { openNewSession },
      }),
    );
    dialog.newSessionHost = sessionHost;
    const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
    await openDialog(dialog);
    const { dialog: modal } = await getRenderedModalDialog(dialog);
    const key = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", {
        ...modifier,
        key: native ? "n" : "O",
        code: native ? "KeyN" : "KeyO",
        shiftKey: !native,
        bubbles: true,
        composed: true,
        cancelable: true,
        ...init,
      });
      modal.dispatchEvent(event);
      return event;
    };
    const blocked = () => {
      expect(key({}).defaultPrevented).toBe(false);
      expect(dialog.isOpen).toBe(true);
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
    const otherModal = document.body.appendChild(document.createElement("openclaw-modal-dialog"));
    await otherModal.updateComplete;
    expect(otherModal.querySelector("dialog")?.open).toBe(true);
    blocked();
    otherModal.remove();
    dialog.newSessionHost = undefined;
    blocked();
    dialog.newSessionHost = sessionHost;
    auth.scopes = ["operator.read"];
    blocked();
    auth.scopes = ["operator.sessions.write"];
    expect(openNewSession).not.toHaveBeenCalled();
    expect(key({}).defaultPrevented).toBe(true);
    await dialog.updateComplete;
    expect(dialog.isOpen).toBe(false);
    expect(openNewSession).toHaveBeenCalledExactlyOnceWith("research");
  },
);

it("closes on modal Escape cancellation", async () => {
  const dialog = await openDialog();

  const cancellation = new CustomEvent("modal-cancel", { cancelable: true });
  dialog.querySelector("openclaw-modal-dialog")?.dispatchEvent(cancellation);
  expect(cancellation.defaultPrevented).toBe(true);
  await dialog.updateComplete;

  expect(dialog.isOpen).toBe(false);
});
