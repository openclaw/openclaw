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
  expect(chips(dialog, "Start new session (from the new-session page)")).toEqual([enter]);
  for (const section of dialog.querySelectorAll("section")) {
    expect(section.querySelector("h3")?.textContent?.trim()).toBeTruthy();
    const rows = section.querySelectorAll(".shortcut-row");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const label = row.querySelector("span")?.textContent?.trim();
      expect(label).toBeTruthy();
      expect(label).not.toContain("shortcutsOverlay.");
      const combos = row.querySelectorAll(".combo");
      expect(combos.length, label).toBeGreaterThan(0);
      for (const combo of combos) {
        const keys = combo.querySelectorAll("kbd");
        expect(keys.length, label).toBeGreaterThan(0);
        for (const key of keys) {
          expect(key.textContent?.trim(), label).toBeTruthy();
        }
      }
    }
  }

  dialog.sendShortcut = "modifier-enter";
  await dialog.updateComplete;

  expect(chips(dialog, "Send message")).toEqual([modifier, enter]);
  expect(chips(dialog, "Start new session (from the new-session page)")).toEqual([modifier, enter]);
  dialog.querySelector<HTMLButtonElement>("button[aria-label='Close']")?.click();
  await dialog.updateComplete;
  expect(dialog.isOpen).toBe(false);
  expect(dialog.querySelector("openclaw-modal-dialog")).toBeNull();
});

it.each([
  { platform: "MacIntel", native: false, chord: ["⌘", "⇧", "O"] },
  { platform: "MacIntel", native: true, chord: ["⌘", "N"] },
  { platform: "Win32", native: false, chord: ["Ctrl", "Shift", "O"] },
  { platform: "Win32", native: true, chord: ["Ctrl", "N"] },
])(
  "displays New Session for $platform/native=$native with either send preference",
  async ({ platform, native, chord }) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    vi.stubGlobal("__OPENCLAW_NATIVE_WEB_CHROME__", native);
    const dialog = await openDialog();
    expect(chips(dialog, "Open New Session")).toEqual(chord);
    dialog.sendShortcut = "modifier-enter";
    await dialog.updateComplete;
    expect(chips(dialog, "Open New Session")).toEqual(chord);
  },
);

it("lists all nine panel shortcuts in order with their Apple key chips", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const dialog = await openDialog();
  const section = Array.from(dialog.querySelectorAll("section")).find(
    (candidate) => candidate.querySelector("h3")?.textContent === "Panels",
  );
  expect(
    Array.from(section?.querySelectorAll(".shortcut-row") ?? [], (row) => [
      row.querySelector("span")?.textContent,
      Array.from(row.querySelectorAll("kbd"), (key) => key.textContent?.trim()),
    ]),
  ).toEqual([
    ["Toggle terminal panel", ["⌃", "`"]],
    ["Talk to your Home agent", ["⌘", "⇧", "H"]],
    ["Toggle workspace files", ["⌘", "⇧", "B"]],
    ["Toggle side chat", ["⌘", "⇧", "S"]],
    ["Toggle browser panel", ["⌘", "⌥", "⇧", "U"]],
    ["Toggle desktop panel", ["⌘", "⌥", "⇧", "D"]],
    ["Toggle discussion panel", ["⌘", "⌥", "⇧", "J"]],
    ["Toggle dashboard panel", ["⌘", "⌥", "⇧", "G"]],
    ["Toggle review panel", ["⌘", "⌥", "⇧", "E"]],
  ]);
});

it("keeps mobile Return for a new line and omits submission shortcuts", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux armv8l");
  const dialog = makeDialog();
  dialog.sendShortcut = "modifier-enter";
  await openDialog(dialog);
  expect(chips(dialog, "Insert new line")).toEqual(["Enter"]);
  const labels = Array.from(
    dialog.querySelectorAll(".shortcut-row > span:first-child"),
    (label) => label.textContent,
  );
  for (const label of [
    "Send message",
    "Start a background session (in the command palette)",
    "Start new session (from the new-session page)",
    "Steer active response",
    "Save queued message",
  ]) {
    expect(labels).not.toContain(label);
  }
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
