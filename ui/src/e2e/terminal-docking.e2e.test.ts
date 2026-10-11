import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI terminal docking" });

suite.define(() => {
  it.each([false, true])(
    "preserves exited diagnostic output across docks (mixed: %s)",
    async (mixed) => {
      await suite.withPage(
        { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          const key = "agent:main:dashboard:11111111-1111-4111-8111-111111111111";
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            sessions: [createControlUiSessionRow(key, "Diagnostic output", 1_790_000_000_000)],
            featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
            terminalEnabled: true,
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          await waitForControlUiGatewayReady(page);
          const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          await openChatSidePanelType(pane, "Terminal");
          const embedded = pane.locator(".sidebar-region__right-runtime openclaw-terminal-panel");
          const bottom = page.locator("openclaw-terminal-panel:not([embedded])");
          await embedded.locator(".tp-host canvas:visible").click();
          await page.keyboard.type("diagnostic-command\r");
          const sessionId = (
            (await gateway.waitForRequest("terminal.input")).params as { sessionId: string }
          ).sessionId;
          await pane.getByRole("button", { name: "Dock to bottom", exact: true }).click();
          await bottom.locator(".tp-host canvas:visible").waitFor();
          if (mixed) {
            await bottom.getByRole("button", { name: "New terminal session", exact: true }).click();
            await expect.poll(() => bottom.locator(".tabstrip-tab.is-live").count()).toBe(2);
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
          const canvas = bottom.locator(".tp-host canvas:visible");
          const original = await canvas.elementHandle();
          const digest = async () =>
            createHash("sha256")
              .update(await canvas.screenshot({ animations: "disabled" }))
              .digest("hex");
          const before = await digest();
          await bottom.getByRole("button", { name: "Dock to right", exact: true }).click();
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR && mixed) {
            const dir = createControlUiE2eArtifactDir("terminal-exited-docking");
            const frame = await takeControlUiScreenshotFrame(
              page,
              pane.locator(".chat-pane__header"),
              [],
              { animations: "disabled" },
            );
            await writeFile(path.join(dir, "exited-dock-to-right.png"), frame.png);
          }
          await pane.getByText("exited (17)", { exact: true }).waitFor();
          expect(
            await embedded
              .locator(".tp-host canvas:visible")
              .evaluate((element, prior) => element === prior, original),
          ).toBe(true);
          await embedded
            .getByText("Command failed; inspect retained output.", { exact: true })
            .waitFor();
          for (let cycle = 0; cycle < 2; cycle += 1) {
            await pane.getByRole("button", { name: "Dock to bottom", exact: true }).click();
            await bottom.getByText("exited (17)", { exact: true }).waitFor();
            expect(await digest()).toBe(before);
            expect(await bottom.locator(".tabstrip-tab").count()).toBe(mixed ? 2 : 1);
            await bottom.getByRole("button", { name: "Dock to right", exact: true }).click();
            await pane.getByText("exited (17)", { exact: true }).waitFor();
            expect(
              await embedded
                .locator(".tp-host canvas:visible")
                .evaluate((element, prior) => element === prior, original),
            ).toBe(true);
          }
          if (mixed) {
            await pane.locator(".sidebar-region__right-runtime .tabstrip-tab.is-live").click();
            await embedded.locator(".tp-host canvas:visible").click();
            await page.keyboard.type("LIVE_WITH_DIAGNOSTICS\r");
            const liveId = (
              (await gateway.getRequests("terminal.input")).at(-1)!.params as { sessionId: string }
            ).sessionId;
            expect(liveId).not.toBe(sessionId);
            await pane.getByRole("button", { name: "Dock to bottom", exact: true }).click();
            await bottom.locator('.tabstrip-tab.is-live[aria-selected="true"]').waitFor();
            await bottom.locator(".tp-host canvas:visible").click();
            await page.keyboard.type("LIVE_STILL_SELECTED\r");
            expect(
              (
                (await gateway.getRequests("terminal.input")).at(-1)!.params as {
                  sessionId: string;
                }
              ).sessionId,
            ).toBe(liveId);
            await bottom.locator(".tabstrip-tab.is-exited").click();
            expect(await canvas.evaluate((element, prior) => element === prior, original)).toBe(
              true,
            );
            expect(await digest()).toBe(before);
          }
          const attaches = await gateway.getRequests("terminal.attach");
          expect(
            attaches.filter(
              (request) => (request.params as { sessionId: string }).sessionId === sessionId,
            ),
          ).toHaveLength(1);
          expect(await gateway.getRequests("terminal.open")).toHaveLength(mixed ? 2 : 1);
          expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
        },
      );
    },
  );

  it.each([
    { destination: "Docking check", populated: false },
    { destination: "Other conversation", populated: false },
    { destination: "Other conversation", populated: true },
  ])(
    "returns the bottom terminal to $destination (populated terminal: $populated)",
    async ({ destination, populated }) => {
      await suite.withPage(
        { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          const keyA = "agent:main:dashboard:11111111-1111-4111-8111-111111111111";
          const keyB = "agent:main:dashboard:22222222-2222-4222-8222-222222222222";
          const gateway = await installMockGateway(page, {
            sessionKey: keyA,
            sessions: [
              createControlUiSessionRow(keyA, "Docking check", 1_790_000_000_000),
              createControlUiSessionRow(keyB, "Other conversation", 1_790_000_000_001),
            ],
            featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
            terminalEnabled: true,
            historyMessages: [
              {
                role: "assistant",
                content: [
                  { type: "text", text: "Keep this terminal beside the current conversation." },
                ],
              },
            ],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, keyA));
          await waitForControlUiGatewayReady(page);
          const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          const selectChat = async (label: string) => {
            await page
              .locator("openclaw-app-sidebar")
              .getByRole("link", { name: label, exact: true })
              .click();
            await activePane
              .locator(".chat-pane__header")
              .getByText(label, { exact: true })
              .waitFor();
          };
          // Keep an independent Files panel in B while moving A’s terminal.
          await selectChat("Other conversation");
          await openChatSidePanelType(activePane, "Files");
          await selectChat("Docking check");
          await openChatSidePanelType(activePane, "Terminal");
          const embedded = activePane.locator(
            ".sidebar-region__right-runtime openclaw-terminal-panel",
          );
          const bottom = page.locator("openclaw-terminal-panel:not([embedded])");
          await embedded.locator(".tp-host canvas:visible").waitFor();
          await embedded.locator(".tp-host canvas:visible").click();
          await page.keyboard.type("echo DOCKING_CONTINUITY\r");
          const input = await gateway.waitForRequest("terminal.input");
          const sessionId = (input.params as { sessionId: string }).sessionId;
          await selectChat("Other conversation");
          await expect.poll(() => embedded.isVisible()).toBe(false);
          await selectChat("Docking check");
          await embedded.locator(".tp-host canvas:visible").waitFor();
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
              expect(
                await bottom
                  .getByRole("button", { name: "Dock to right", exact: true })
                  .isDisabled(),
              ).toBe(true);
            } finally {
              await gateway.resolveDeferred("terminal.open");
            }
            await expect.poll(() => bottom.locator(".tabstrip-tab.is-live").count()).toBe(2);
            await bottom.locator(".tabstrip-tab").first().click();
            await openChatSidePanelType(activePane, "Terminal");
            await embedded.locator(".tp-host canvas:visible").waitFor();
            await openChatSidePanelType(activePane, "Terminal");
            await expect
              .poll(async () => (await gateway.getRequests("terminal.open")).length)
              .toBe(3);
            await embedded.locator(".tp-host canvas:visible").waitFor();
          }
          await bottom.getByRole("button", { name: "Dock to right", exact: true }).click();
          // Capture the same settled post-click state on both the broken and repaired source.
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR && destination === "Docking check") {
            const dir = createControlUiE2eArtifactDir("terminal-docking");
            const frame = await takeControlUiScreenshotFrame(
              page,
              activePane.locator(".chat-pane__header"),
              [
                activePane.getByText("Keep this terminal beside the current conversation.", {
                  exact: true,
                }),
              ],
              { animations: "disabled" },
            );
            await writeFile(path.join(dir, "dock-to-right.png"), frame.png);
          }
          await embedded.locator(".tp-host canvas:visible").waitFor();
          await expect.poll(() => bottom.locator(".tp").count()).toBe(0);
          if (populated) {
            await expect
              .poll(() =>
                activePane.locator(".sidebar-region__right-runtime .tabstrip-tab.is-live").count(),
              )
              .toBe(3);
          }
          await embedded.locator(".tp-host canvas:visible").click();
          await page.keyboard.type("ROUND_TRIP_OK\r");
          await expect
            .poll(async () =>
              (await gateway.getRequests("terminal.input"))
                .map((request) => (request.params as { data: string }).data)
                .join(""),
            )
            .toContain("ROUND_TRIP_OK");
          const inputs = await gateway.getRequests("terminal.input");
          expect(
            inputs.every(
              (request) => (request.params as { sessionId: string }).sessionId === sessionId,
            ),
          ).toBe(true);
          expect(await gateway.getRequests("terminal.open")).toHaveLength(populated ? 3 : 1);
          expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
          if (destination === "Other conversation") {
            expect(await activePane.locator('[data-panel-slot="workspace"]').count()).toBe(1);
          }
          if (populated) {
            // B stays mounted while A hands its restored tabs to the bottom host.
            await selectChat("Docking check");
            await openChatSidePanelType(activePane, "Terminal");
            await embedded.locator(".tp-host canvas:visible").waitFor();
            await activePane.getByRole("button", { name: "Dock to bottom", exact: true }).click();
            await expect.poll(() => bottom.locator(".tabstrip-tab.is-live").count()).toBe(3);
            await selectChat("Other conversation");
            await bottom.locator(".tp-host canvas:visible").click();
            await page.keyboard.type("RETAINED_SOURCE\r");
            const retainedId = (
              (await gateway.getRequests("terminal.input")).at(-1)!.params as { sessionId: string }
            ).sessionId;
            await bottom.getByRole("button", { name: "Dock to right", exact: true }).click();
            await embedded.locator(".tp-host canvas:visible").click();
            await page.keyboard.type("RETAINED_DESTINATION\r");
            expect(
              (
                (await gateway.getRequests("terminal.input")).at(-1)!.params as {
                  sessionId: string;
                }
              ).sessionId,
            ).toBe(retainedId);
            await activePane
              .locator(".sidebar-region__right-runtime .tabstrip-tab.is-live")
              .last()
              .click();
            await embedded.locator(".tp-host canvas:visible").click();
            await page.keyboard.type("DESTINATION_TAB\r");
            const destinationInputs = await gateway.getRequests("terminal.input");
            const destinationId = (destinationInputs.at(-1)!.params as { sessionId: string })
              .sessionId;
            expect(destinationId).not.toBe(sessionId);
            await activePane.getByRole("button", { name: "Dock to bottom", exact: true }).click();
            await expect.poll(() => bottom.locator(".tabstrip-tab.is-live").count()).toBe(3);
            await bottom.locator(".tp-host canvas:visible").click();
            await page.keyboard.type("BOTTOM_RETURN\r");
            expect(
              (
                (await gateway.getRequests("terminal.input")).at(-1)!.params as {
                  sessionId: string;
                }
              ).sessionId,
            ).toBe(destinationId);
            await bottom.getByRole("button", { name: "Dock to right", exact: true }).click();
            await expect
              .poll(() =>
                activePane.locator(".sidebar-region__right-runtime .tabstrip-tab.is-live").count(),
              )
              .toBe(3);
            await embedded.locator(".tp-host canvas:visible").click();
            await page.keyboard.type("RIGHT_RETURN\r");
            expect(
              (
                (await gateway.getRequests("terminal.input")).at(-1)!.params as {
                  sessionId: string;
                }
              ).sessionId,
            ).toBe(destinationId);
            expect(await gateway.getRequests("terminal.open")).toHaveLength(3);
            expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
          }
          await selectChat(
            destination === "Docking check" ? "Other conversation" : "Docking check",
          );
          await expect.poll(() => embedded.isVisible()).toBe(false);
          await selectChat(destination);
          await embedded.locator(".tp-host canvas:visible").waitFor();
          await page.locator(".sidebar-session-toolbar .sidebar-new-session").click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
          await expect.poll(() => bottom.locator(".tp").count()).toBe(0);
        },
      );
    },
  );
});
