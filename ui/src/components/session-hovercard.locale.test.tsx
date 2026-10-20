/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import { i18n } from "../i18n/index.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { SessionHovercard } from "./session-hovercard-solid.tsx";

function mountCard(
  initial: SidebarSessionHovercardRow,
  automationLink?: Parameters<typeof SessionHovercard>[0]["automationLink"],
) {
  const [row, setRow] = createSignal<SidebarSessionHovercardRow | undefined>(initial);
  const view = mountSolid(() => <SessionHovercard row={row()} automationLink={automationLink} />);
  onTestFinished(view.unmount);
  const find = (suffix = "") =>
    view.container.querySelector<HTMLElement>(`.session-hovercard${suffix}`);
  const parts = () => ({
    channel: find("__channel"),
    creator: find("__creator-avatar"),
    color: view.container.querySelector(".session-color-dot"),
  });
  return { ...view, find, parts, setRow };
}

it("refreshes retained hovercard labels and age without replacing its focused link", async () => {
  const restoreI18n = captureI18nStateForTesting();
  await i18n.setLocale("en");
  const row: SidebarSessionHovercardRow = {
    label: "Example session",
    hasActiveRun: false,
    hasAutomation: true,
    createdAt: Date.now() - 2 * 60 * 60_000,
    channelPresentation: { channel: "slack", channelLabel: "Slack", kind: "group" },
    workContext: { kind: "project", name: "Example", path: "/workspace/example" },
    placementProviderId: "local",
    placementProfileId: "default",
    placementMachine: { cpu: 4, memoryGb: 16 },
    attention: {
      kind: "error",
      reason: "Synthetic failure",
      sourceSessionKey: "agent:main:example",
    },
  };
  const view = mountCard(row, {
    gateway: null,
    sessionKey: "agent:main:example",
    agentId: "main",
    href: "/automations",
    navigate: () => {},
  });
  onTestFinished(async () => {
    view.unmount();
    await restoreI18n();
  });
  await waitForSolid(() => expect(view.find("__automation-link")).not.toBeNull());
  const card = view.find();
  const link = view.find("__automation-link")!;
  link.focus();
  await waitForSolid(() => {
    expect(card?.textContent).toContain("Linked to Slack");
    expect(card?.querySelector('[aria-label="Project: Example"]')).not.toBeNull();
    expect(card?.querySelector('[aria-label="Runs on local · default"]')).not.toBeNull();
    expect(view.find("__created-age")).toMatchObject({ textContent: "2h" });
    expect(card?.textContent).toContain("Run failed: Synthetic failure");
    expect(card?.querySelector(".session-hovercard__machine")?.textContent).toContain("16 GB");
  });

  await i18n.setLocale("de");
  await waitForSolid(() => {
    expect(card?.textContent).toContain("Mit Slack verknüpft");
    expect(card?.querySelector('[aria-label="Projekt: Example"]')).not.toBeNull();
    expect(card?.querySelector('[aria-label="Läuft auf local · default"]')).not.toBeNull();
    expect(view.find("__created-age")).toMatchObject({
      textContent: "2 Std.",
      title: "vor 2 Std.",
    });
    expect(card?.textContent).toContain("Ausführung fehlgeschlagen: Synthetic failure");
    expect(view.find()).toBe(card);
    expect(document.activeElement).toBe(link);
  });

  const machine = view.find("__machine");
  await i18n.setLocale("fr");
  await waitForSolid(() => {
    expect(machine?.textContent).toContain("16 Go");
    expect(view.find("__machine")).toBe(machine);
    expect(document.activeElement).toBe(link);
  });
});

it("retains the header across row updates and clears optional details without stale snapshots", async () => {
  const initial: SidebarSessionHovercardRow = {
    label: "Synthetic session",
    hasActiveRun: false,
    hasAutomation: false,
    color: "blue",
    channelPresentation: { channel: "slack", channelLabel: "Slack", kind: "group" },
    createdActor: {
      type: "human",
      id: "synthetic-person",
      label: "Synthetic person",
      identity: { type: "profile", id: "synthetic-person" },
    },
  };
  const { find, parts, setRow } = mountCard(initial);
  const populated = { color: expect.any(Element), creator: expect.any(Element) };
  await waitForSolid(() => expect(parts()).toMatchObject(populated));
  const header = find("__header");
  setRow({ ...initial, label: "Updated synthetic session", color: "purple" });
  await waitForSolid(() => {
    expect(find("__header")).toBe(header);
    expect(header?.textContent).toContain("Updated synthetic session");
    expect(parts().color?.getAttribute("style")).toContain("session-color-purple");
  });
  setRow({ label: "Plain synthetic session", hasActiveRun: false, hasAutomation: false });
  await waitForSolid(() => {
    expect(find("__header")).toBe(header);
    expect(parts()).toEqual({ color: null, channel: null, creator: null });
  });
  setRow(undefined);
  await waitForSolid(() => expect(find()).toBeNull());
  setRow(initial);
  await waitForSolid(() => {
    expect(find("__header")?.textContent).toContain("Synthetic session");
    expect(parts()).toMatchObject(populated);
  });
});
