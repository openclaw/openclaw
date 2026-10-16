/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { i18n } from "../i18n/index.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { SessionHovercard } from "./session-hovercard-solid.tsx";

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
  const view = mountSolid(() => (
    <SessionHovercard
      row={row}
      automationLink={{
        gateway: null,
        sessionKey: "agent:main:example",
        agentId: "main",
        href: "/automations",
        navigate: () => {},
      }}
    />
  ));
  onTestFinished(async () => {
    view.unmount();
    await restoreI18n();
  });
  await waitForSolid(() =>
    expect(view.container.querySelector(".session-hovercard__automation-link")).not.toBeNull(),
  );
  const card = view.container.querySelector(".session-hovercard");
  const link = view.container.querySelector<HTMLAnchorElement>(
    ".session-hovercard__automation-link",
  )!;
  link.focus();
  await waitForSolid(() => {
    expect(card?.textContent).toContain("Linked to Slack");
    expect(card?.querySelector('[aria-label="Project: Example"]')).not.toBeNull();
    expect(card?.querySelector('[aria-label="Runs on local · default"]')).not.toBeNull();
    expect(card?.querySelector(".session-hovercard__created-age")?.textContent).toBe("2h");
    expect(card?.textContent).toContain("Run failed: Synthetic failure");
    expect(card?.querySelector(".session-hovercard__machine")?.textContent).toContain("16 GB");
  });

  await i18n.setLocale("de");
  await waitForSolid(() => {
    expect(card?.textContent).toContain("Mit Slack verknüpft");
    expect(card?.querySelector('[aria-label="Projekt: Example"]')).not.toBeNull();
    expect(card?.querySelector('[aria-label="Läuft auf local · default"]')).not.toBeNull();
    const age = card?.querySelector(".session-hovercard__created-age");
    expect(age?.textContent).toBe("2 Std.");
    expect(age?.getAttribute("title")).toBe("vor 2 Std.");
    expect(card?.textContent).toContain("Ausführung fehlgeschlagen: Synthetic failure");
    expect(view.container.querySelector(".session-hovercard")).toBe(card);
    expect(document.activeElement).toBe(link);
  });

  const machine = card?.querySelector(".session-hovercard__machine");
  await i18n.setLocale("fr");
  await waitForSolid(() => {
    expect(machine?.textContent).toContain("16 Go");
    expect(card?.querySelector(".session-hovercard__machine")).toBe(machine);
    expect(document.activeElement).toBe(link);
  });
});
