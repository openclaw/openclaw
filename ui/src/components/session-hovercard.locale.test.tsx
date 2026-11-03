/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { createContext, createSessions } from "../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { installRepositoryPresentation } from "../test-helpers/repository-presentation.test-support.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { SessionHovercard } from "./session-hovercard-solid.tsx";

function mountCard(
  initial: SidebarSessionHovercardRow,
  initialProps: Omit<Parameters<typeof SessionHovercard>[0], "row"> = {},
  context?: ApplicationContext,
) {
  const [row, setRow] = createSignal<SidebarSessionHovercardRow | undefined>(initial);
  const [props, setProps] = createSignal(initialProps);
  const view = mountSolid(() => <SessionHovercard {...props()} row={row()} />, {
    wrapper: context ? createSolidApplicationContextProvider(context).wrapper : undefined,
  });
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
  const key = "agent:main:hovercard-locale";
  const connection = createApplicationGateway();
  connection.publish({
    ...connection.gateway.snapshot,
    phase: "connected",
    hello: gatewayHelloForMethods(["controlUi.sessionPullRequests.subscribe"], ["operator.read"]),
    client: createTestGatewayClient(async () => ({})),
  });
  const source = createContext(connection.gateway, createSessions("main", [key]));
  const activation = installRepositoryPresentation(source, () => ({
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
  }));
  const view = mountCard(
    row,
    { session: { sessionKey: key, agentId: "main" } },
    activation.context,
  );
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
