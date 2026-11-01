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
  initialProps: Omit<Parameters<typeof SessionHovercard>[0], "row"> = {},
) {
  const [row, setRow] = createSignal<SidebarSessionHovercardRow | undefined>(initial);
  const [props, setProps] = createSignal(initialProps);
  const view = mountSolid(() => <SessionHovercard {...props()} row={row()} />);
  const find = (suffix = "") =>
    view.container.querySelector<HTMLElement>(`.session-hovercard${suffix}`);
  const parts = () => ({
    channel: find("__channel"),
    creator: find("__creator-avatar"),
  });
  return { ...view, find, parts, setRow, setProps };
}

it("preserves live hovercard content, focus, and translated actions across updates", async () => {
  const restoreI18n = captureI18nStateForTesting();
  await i18n.setLocale("en");
  const row: SidebarSessionHovercardRow = {
    label: "Example session",
    createdActor: { type: "human", id: "ada", label: "Ada" },
    hasActiveRun: false,
    hasAutomation: false,
    createdAt: Date.now() - 2 * 60 * 60_000,
    channelPresentation: { channel: "slack", channelLabel: "Slack", kind: "group" },
    workContext: { kind: "project", name: "Example", path: "/workspace/example" },
    placementProviderId: "local",
    placementProfileId: "default",
    attention: { kind: "error", reason: "Failure", sourceSessionKey: "agent:main:example" },
  };
  const view = mountCard(row, {
    pullRequests: {
      status: "ready",
      rateLimited: false,
      pullRequests: [
        {
          owner: "example",
          repo: "project",
          number: 7,
          branch: "feature",
          title: "Example request",
          url: "https://github.com/example/project/pull/7",
          state: "open",
        },
      ],
    },
  });
  onTestFinished(async () => {
    view.unmount();
    await restoreI18n();
  });
  await waitForSolid(() => expect(view.find("__pr-row")).not.toBeNull());
  const card = view.find();
  const populated = { creator: expect.any(Element) };
  expect(view.parts()).toMatchObject(populated);
  const link = view.find("__pr-row")!;
  link.focus();
  await i18n.setLocale("de");
  await waitForSolid(() => {
    for (const text of ["Mit Slack verknüpft", "Ausführung fehlgeschlagen: Failure"]) {
      expect(card?.textContent).toContain(text);
    }
    for (const label of ["Projekt: Example", "Läuft auf local · default"]) {
      expect(card?.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(view.find("__created-age")).toMatchObject({
      textContent: "2 Std.",
      title: "vor 2 Std.",
    });
    expect(view.find()).toBe(card);
    expect(document.activeElement).toBe(link);
  });
  await i18n.setLocale("fr");
  await waitForSolid(() => {
    expect(view.find("__created-age")?.textContent).toContain("2");
    expect(view.find("__section-title")?.textContent).not.toBe("Pull requests");
    expect(document.activeElement).toBe(link);
  });
  const { find, parts, setRow } = view;
  view.setProps({});
  const header = find("__header");
  setRow({ ...row, label: "Updated synthetic session" });
  await waitForSolid(() => {
    expect(find("__header")).toBe(header);
    expect(header?.textContent).toContain("Updated synthetic session");
  });
  setRow({ label: "Plain synthetic session", hasActiveRun: false, hasAutomation: false });
  await waitForSolid(() => {
    expect(find("__header")).toBe(header);
    expect(parts()).toEqual({ channel: null, creator: null });
  });
  setRow(undefined);
  await waitForSolid(() => expect(find()).toBeNull());
  setRow(row);
  await waitForSolid(() => {
    expect(find("__header")?.textContent).toContain("Example session");
    expect(parts()).toMatchObject(populated);
  });
});
