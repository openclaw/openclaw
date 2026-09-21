import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureDeviceRuntimeUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])(
    "warns without allowing unsupported computer selection ($name)",
    async ({ name, width, height }) => {
      const context = await suite.browser.newContext({
        ...createControlUiE2eContextOptions(),
        viewport: { width, height },
        ...(name === "mobile" ? { isMobile: true, hasTouch: true } : {}),
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        agentModel: "openai/test-model",
        featureMethods: [
          "agent.wait",
          "chat.metadata",
          "chat.startup",
          "projects.list",
          "sessions.create",
          "sessions.dispatch",
        ],
        models: [
          {
            available: true,
            id: "test-model",
            name: "Example model",
            provider: "openai",
            agentRuntime: {
              id: "codex",
              cloudPlacementSupported: true,
              devicePlacementSupported: true,
              devicePlacement: {
                requiredNodeCommands: ["codex.exec-server.stdio.v1"],
                consumesWorkerSlot: false,
                setup: {
                  label: "Codex",
                  missingCommandHint:
                    "Install or enable the OpenClaw Codex plugin in this computer's node service, then reconnect. Update OpenClaw first if the plugin requires a newer version. The model connection stays on the OpenClaw server.",
                },
              },
              source: "model",
            },
          },
        ],
        methodResponses: {
          "environments.list": {
            environments: [
              {
                id: "node:build-mac",
                type: "node",
                label: "Build Mac",
                platform: "macos",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 4, available: 4 },
                capabilities: ["system.run"],
                invocableCommands: ["system.run"],
                requiredNodeCommand: { command: "codex.exec-server.stdio.v1", state: "undeclared" },
              },
            ],
          },
          "projects.list": {
            projects: [
              { id: "one", displayName: "Project one", repoRoot: "/one" },
              { id: "two", displayName: "Project two", repoRoot: "/two" },
            ],
          },
          "sessions.create": { key: "agent:main:server-session", runStarted: true },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await openEnvironmentPicker(page);
        const row = page.locator('[data-value="device:build-mac"]');
        await expect.poll(() => row.getAttribute("aria-disabled")).toBe("true");
        expect(await row.textContent()).toContain("Unavailable");
        expect(await row.locator(".new-session-page__environment-warning").count()).toBe(1);
        expect(await page.locator('[data-value^="node-tools:"]').count()).toBe(0);
        const before = await page.locator("#new-session-where-trigger").textContent();
        await captureDeviceRuntimeUiProof(suite, page, `node-warning-picker-${name}.png`);
        if (name === "mobile") {
          // Playwright correctly treats aria-disabled as blocked; a real pointer tap
          // must still reveal the warning without selecting the computer.
          const box = await row.boundingBox();
          if (!box) {
            throw new Error("Missing blocked row bounds");
          }
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await page.keyboard.press("Tab");
          await row.focus();
        }
        const tooltip = page.locator(
          'openclaw-tooltip:has([data-value="device:build-mac"]) wa-tooltip',
        );
        await expect
          .poll(() =>
            tooltip.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
          )
          .toBe(true);
        const warning = tooltip.locator(".tooltip-content");
        expect(await warning.textContent()).toContain("Codex integration unavailable.");
        expect(await warning.textContent()).toContain("OpenClaw Codex plugin");
        expect(await warning.textContent()).not.toContain("codex.exec-server");
        await captureDeviceRuntimeUiProof(suite, page, `node-warning-tooltip-${name}.png`);
        await row.focus();
        await page.keyboard.press("Enter");
        await page.keyboard.press("Space");
        expect(await page.locator("#new-session-where-trigger").textContent()).toBe(before);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        await page.locator('[data-value="gateway"]').click();
        if (name === "desktop") {
          await page.keyboard.press("ControlOrMeta+K");
          const palette = page.locator("openclaw-command-palette");
          await palette.locator(".cmd-palette__input").fill("Check blocked computer");
          await palette.getByRole("button", { name: "New session settings", exact: true }).click();
          await palette.locator(".palette-session-settings__workspace").click();
          const blocked = palette.locator('[data-machine="device:build-mac"]');
          await expect.poll(() => blocked.count()).toBe(1);
          await expect.poll(() => palette.locator('[data-machine="local"]').count()).toBe(3);
          await expect
            .poll(() => blocked.getAttribute("aria-description"))
            .toContain("Codex integration unavailable.");
          expect(await blocked.getAttribute("aria-disabled")).toBe("true");
          expect(await palette.locator('[data-machine^="node-tools:"]').count()).toBe(0);
          await blocked.focus();
          await page.keyboard.press("Enter");
          expect(await blocked.getAttribute("aria-pressed")).toBe("false");
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          const paletteTooltip = blocked
            .locator("xpath=ancestor::openclaw-tooltip[1]")
            .locator("wa-tooltip");
          await expect
            .poll(() =>
              paletteTooltip.evaluate(
                (element) => (element as HTMLElement & { open: boolean }).open,
              ),
            )
            .toBe(true);
          await captureDeviceRuntimeUiProof(suite, page, "node-warning-palette-desktop.png");
          await page.keyboard.press("ControlOrMeta+K");
          await palette.locator(".cmd-palette__input").waitFor({ state: "hidden" });
        }
        await page.locator(".new-session-page__message").fill("Continue on the server");
        await page.getByRole("button", { name: "Start session" }).click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).not.toHaveProperty("execNode");
        expect(create.params).toMatchObject({ message: "Continue on the server" });
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      } finally {
        await context.close();
      }
    },
  );
});
