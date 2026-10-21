import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI terminal docking" });

const terminalCanvas = (panel: Locator) => panel.locator(".tp-host canvas:visible");
const liveTabs = (panel: Locator) => panel.locator(".tabstrip-tab.is-live");
const rightTabs = (pane: Locator) =>
  pane.locator(".sidebar-region__right-runtime .tabstrip-tab.is-live");
const dock = (panel: Locator, side: "bottom" | "right") =>
  panel.getByRole("button", { name: "Dock to " + side, exact: true }).click();
const inputSession = (request: { params?: unknown }) =>
  (request.params as { sessionId: string }).sessionId;
const lastInputSession = async (gateway: Awaited<ReturnType<typeof installMockGateway>>) =>
  inputSession((await gateway.getRequests("terminal.input")).at(-1)!);
async function typeInTerminal(page: Page, panel: Locator, text: string) {
  await terminalCanvas(panel).click();
  await page.keyboard.type(text);
}
function hasFocus(element: Element, descendants = false) {
  const root = element.getRootNode();
  const active =
    root instanceof ShadowRoot ? root.activeElement : element.ownerDocument.activeElement;
  return descendants ? element.contains(active) : element === active;
}
async function openDockingChat(page: Page, labels: string[], content?: string) {
  const keys = [
    "agent:main:dashboard:11111111-1111-4111-8111-111111111111",
    "agent:main:dashboard:22222222-2222-4222-8222-222222222222",
  ];
  const gateway = await installMockGateway(page, {
    sessionKey: keys[0],
    sessions: labels.map((label, index) =>
      createControlUiSessionRow(keys[index]!, label, 1_790_000_000_000 + index),
    ),
    featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
    terminalEnabled: true,
    ...(content
      ? { historyMessages: [{ role: "assistant", content: [{ type: "text", text: content }] }] }
      : {}),
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, keys[0]!));
  await waitForControlUiGatewayReady(page);
  const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
  return {
    gateway,
    pane,
    embedded: pane.locator(".sidebar-region__right-runtime openclaw-terminal-panel"),
    bottom: page.locator("openclaw-terminal-panel:not([embedded])"),
  };
}

suite.define(() => {
  it.each([false, true])("preserves exited diagnostic output across docks (mixed: %s)", (mixed) =>
    suite.withPage(
      { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const { gateway, pane, embedded, bottom } = await openDockingChat(page, [
          "Diagnostic output",
        ]);
        await openChatSidePanelType(pane, "Terminal");
        // Embedded desktop opens on Sessions; choose the already-owned session.
        await embedded.locator(".tp-session.is-current").click();
        await typeInTerminal(page, embedded, "diagnostic-command\r");
        const sessionId = inputSession(await gateway.waitForRequest("terminal.input"));
        await dock(pane, "bottom");
        await terminalCanvas(bottom).waitFor();
        if (mixed) {
          await bottom.getByRole("button", { name: "New terminal session", exact: true }).click();
          await expect.poll(() => liveTabs(bottom).count()).toBe(2);
          await bottom.locator(".tabstrip-tab").first().click();
        }
        const output =
          "\u001b[2J\u001b[H\u001b[?25lDIAGNOSTIC_OUTPUT_RETAINED\r\ncommand failed: exit 17\r\n";
        const echoed = (await gateway.getRequests("terminal.input")).reduce((size, request) => {
          const input = request.params as { sessionId: string; data: string };
          return size + (input.sessionId === sessionId ? input.data.length : 0);
        }, 0);
        const banner =
          "OpenClaw mock terminal\r\nType anything and the mock Gateway will echo it.\r\n$ ";
        await gateway.emitGatewayEvent("terminal.data", {
          sessionId,
          seq: banner.length + echoed + output.length,
          data: output,
        });
        await gateway.emitGatewayEvent("terminal.exit", {
          sessionId,
          reason: "process_exit",
          exitCode: 17,
          signal: null,
          error: "Command failed; inspect retained output.",
        });
        await bottom.getByText("exited (17)", { exact: true }).waitFor();
        const canvas = terminalCanvas(bottom);
        const original = await canvas.elementHandle();
        const expectOriginalCanvas = async (panel: Locator) =>
          expect(
            await terminalCanvas(panel).evaluate((element, prior) => element === prior, original),
          ).toBe(true);
        const digest = async () =>
          createHash("sha256")
            .update(await canvas.screenshot({ animations: "disabled" }))
            .digest("hex");
        const before = await digest();
        await dock(bottom, "right");
        await pane.getByText("exited (17)", { exact: true }).waitFor();
        await expectOriginalCanvas(embedded);
        await embedded
          .getByText("Command failed; inspect retained output.", { exact: true })
          .waitFor();
        for (let cycle = 0; cycle < 2; cycle += 1) {
          await dock(pane, "bottom");
          await bottom.getByText("exited (17)", { exact: true }).waitFor();
          expect(await digest()).toBe(before);
          expect(await bottom.locator(".tabstrip-tab").count()).toBe(mixed ? 2 : 1);
          await dock(bottom, "right");
          await pane.getByText("exited (17)", { exact: true }).waitFor();
          await expectOriginalCanvas(embedded);
        }
        if (mixed) {
          await pane.locator(".sidebar-region__right-runtime .tabstrip-tab.is-live").click();
          await typeInTerminal(page, embedded, "LIVE_WITH_DIAGNOSTICS\r");
          const liveId = await lastInputSession(gateway);
          expect(liveId).not.toBe(sessionId);
          await dock(pane, "bottom");
          await bottom.locator('.tabstrip-tab.is-live[aria-selected="true"]').waitFor();
          await typeInTerminal(page, bottom, "LIVE_STILL_SELECTED\r");
          expect(await lastInputSession(gateway)).toBe(liveId);
          await bottom.locator(".tabstrip-tab.is-exited").click();
          await expectOriginalCanvas(bottom);
          expect(await digest()).toBe(before);
        }
        const attaches = await gateway.getRequests("terminal.attach");
        expect(attaches.filter((request) => inputSession(request) === sessionId)).toHaveLength(1);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(mixed ? 2 : 1);
        expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
      },
    ),
  );

  it.each([
    { destination: "Docking check", populated: false, picker: "pointer" },
    { destination: "Other conversation", populated: false, picker: "pointer" },
    { destination: "Other conversation", populated: true, picker: "pointer" },
    { destination: "Other conversation", populated: true, picker: "keyboard" },
  ])(
    "returns the bottom terminal to $destination (populated terminal: $populated; picker: $picker)",
    ({ destination, populated, picker }) =>
      suite.withPage(
        { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          const {
            gateway,
            pane: activePane,
            embedded,
            bottom,
          } = await openDockingChat(
            page,
            ["Docking check", "Other conversation"],
            "Keep this terminal beside the current conversation.",
          );
          const sidebar = page.locator("openclaw-app-sidebar");
          const header = activePane.locator(".chat-pane__header");
          const selectChat = async (label: string) => {
            await sidebar.getByRole("link", { name: label, exact: true }).click();
            await header.getByText(label, { exact: true }).waitFor();
          };
          // Keep an independent Files panel in B while moving A’s terminal.
          await selectChat("Other conversation");
          await openChatSidePanelType(activePane, "Files");
          await selectChat("Docking check");
          await openChatSidePanelType(activePane, "Terminal");
          // Embedded desktop opens on Sessions; choose the already-owned session.
          await embedded.locator(".tp-session.is-current").click();
          await typeInTerminal(page, embedded, "echo DOCKING_CONTINUITY\r");
          const sessionId = inputSession(await gateway.waitForRequest("terminal.input"));
          await selectChat("Other conversation");
          await expect.poll(() => embedded.isVisible()).toBe(false);
          await selectChat("Docking check");
          await terminalCanvas(embedded).waitFor();
          await page.getByRole("button", { name: "Dock to bottom", exact: true }).click();
          await bottom.locator(".tp--bottom canvas").waitFor();
          await selectChat("Other conversation");
          await bottom.locator(".tp--bottom canvas").waitFor();
          await selectChat(destination);
          if (populated) {
            const after = await gateway.deferNext("terminal.open");
            await bottom.getByRole("button", { name: "New terminal session", exact: true }).click();
            await gateway.waitForRequest("terminal.open", { after });
            try {
              const dockRight = bottom.getByRole("button", { name: "Dock to right", exact: true });
              expect(await dockRight.isDisabled()).toBe(true);
            } finally {
              await gateway.resolveDeferred("terminal.open");
            }
            await expect.poll(() => liveTabs(bottom).count()).toBe(2);
            await bottom.locator(".tabstrip-tab").first().click();
            // A visible first canvas does not mean the remaining restored sessions have booted.
            const restoreAfter = await gateway.deferNext("terminal.attach");
            await openChatSidePanelType(activePane, "Terminal");
            await gateway.waitForRequest("terminal.attach", { after: restoreAfter });
            const positionTrigger = activePane.getByRole("button", {
              name: "Panel position",
              exact: true,
            });
            const menu = positionTrigger.locator("..").locator('[role="menu"]');
            const rightPosition = menu.getByRole("menuitemradio", { name: "Right", exact: true });
            const expectMenu = async (open: boolean) => {
              expect(await positionTrigger.getAttribute("aria-expanded")).toBe(String(open));
              expect(await menu.evaluate((element) => element.matches(":popover-open"))).toBe(open);
              expect((await menu.getAttribute("inert")) === null).toBe(open);
            };
            const openPicker = async () => {
              if (picker === "keyboard") {
                await positionTrigger.focus();
                await page.keyboard.press("ArrowDown");
              } else {
                await positionTrigger.click();
              }
              await expect.poll(() => menu.getAttribute("data-phase")).toBe("open");
            };
            let restoreReleased = false;
            try {
              await embedded.locator(".tp-host canvas").waitFor({ state: "attached" });
              await openPicker();
              await gateway.resolveDeferred("terminal.attach");
              restoreReleased = true;
              await gateway.waitForRequest("terminal.attach", { after: restoreAfter + 1 });
              await expect.poll(() => rightTabs(activePane).count()).toBe(2);
              await expectMenu(true);
              expect(await menu.evaluate(hasFocus, true)).toBe(true);

              await page.keyboard.press("Escape");
              await expect.poll(() => menu.getAttribute("data-phase")).toBe("hidden");
              await expectMenu(false);
              await openPicker();
              await activePane.locator(".agent-chat__composer-combobox textarea").click();
              await expect.poll(() => menu.getAttribute("data-phase")).toBe("hidden");
              expect(await menu.evaluate((element) => element.matches(":popover-open"))).toBe(
                false,
              );
              await openPicker();
              if (picker === "keyboard") {
                // Chat chrome delegates unadvertised printable keys to the composer.
                const labels = await menu
                  .getByRole("menuitemradio")
                  .evaluateAll((elements) =>
                    elements.map((element) => element.getAttribute("aria-label")),
                  );
                const positionIndex = labels.indexOf("Right");
                expect(positionIndex).toBeGreaterThanOrEqual(0);
                await page.keyboard.press("Home");
                for (let index = 0; index < positionIndex; index += 1) {
                  await page.keyboard.press("ArrowDown");
                }
                await expect.poll(() => rightPosition.evaluate(hasFocus)).toBe(true);
                await page.keyboard.press("Enter");
              } else {
                await rightPosition.click();
              }
              await expect.poll(() => menu.getAttribute("data-phase")).toBe("hidden");
              expect(await positionTrigger.getAttribute("aria-expanded")).toBe("false");
            } finally {
              if (!restoreReleased) {
                await gateway.resolveDeferred("terminal.attach");
              }
            }
            await activePane.getByRole("button", { name: "New tab", exact: true }).click();
            await activePane
              .locator(".side-panel-launcher")
              .getByRole("button", { name: /^Terminal\b/ })
              .click();
            await expect
              .poll(async () => (await gateway.getRequests("terminal.open")).length)
              .toBe(3);
            await terminalCanvas(embedded).waitFor();
          }
          await dock(bottom, "right");
          await expect.poll(() => bottom.locator(".tp").count()).toBe(0);
          if (populated) {
            await expect.poll(() => rightTabs(activePane).count()).toBe(3);
          }
          await typeInTerminal(page, embedded, "ROUND_TRIP_OK\r");
          await expect
            .poll(async () =>
              (await gateway.getRequests("terminal.input"))
                .map((request) => (request.params as { data: string }).data)
                .join(""),
            )
            .toContain("ROUND_TRIP_OK");
          const inputs = await gateway.getRequests("terminal.input");
          expect(inputs.every((request) => inputSession(request) === sessionId)).toBe(true);
          expect(await gateway.getRequests("terminal.open")).toHaveLength(populated ? 3 : 1);
          expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
          if (destination === "Other conversation") {
            expect(await activePane.locator('[data-panel-slot="workspace"]').count()).toBe(1);
          }
          if (populated) {
            // B stays mounted while A hands its restored tabs to the bottom host.
            await selectChat("Docking check");
            await openChatSidePanelType(activePane, "Terminal");
            await embedded.locator(".tp-session-menu--inline").waitFor();
            await dock(activePane, "bottom");
            await expect.poll(() => liveTabs(bottom).count()).toBe(3);
            await selectChat("Other conversation");
            await typeInTerminal(page, bottom, "RETAINED_SOURCE\r");
            const retainedId = await lastInputSession(gateway);
            await dock(bottom, "right");
            await typeInTerminal(page, embedded, "RETAINED_DESTINATION\r");
            expect(await lastInputSession(gateway)).toBe(retainedId);
            await rightTabs(activePane).last().click();
            await typeInTerminal(page, embedded, "DESTINATION_TAB\r");
            const destinationId = await lastInputSession(gateway);
            expect(destinationId).not.toBe(sessionId);
            await dock(activePane, "bottom");
            await expect.poll(() => liveTabs(bottom).count()).toBe(3);
            await typeInTerminal(page, bottom, "BOTTOM_RETURN\r");
            expect(await lastInputSession(gateway)).toBe(destinationId);
            await dock(bottom, "right");
            await expect.poll(() => rightTabs(activePane).count()).toBe(3);
            await typeInTerminal(page, embedded, "RIGHT_RETURN\r");
            expect(await lastInputSession(gateway)).toBe(destinationId);
            expect(await gateway.getRequests("terminal.open")).toHaveLength(3);
            expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
          }
          await selectChat(
            destination === "Docking check" ? "Other conversation" : "Docking check",
          );
          await expect.poll(() => embedded.isVisible()).toBe(false);
          await selectChat(destination);
          await terminalCanvas(embedded).waitFor();
          await page.locator(".sidebar-rail .sidebar-new-session").click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
          await expect.poll(() => bottom.locator(".tp").count()).toBe(0);
        },
      ),
  );
});
