import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import type { DraftEnvironment } from "../pages/new-session/discovery.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  pollText,
  pollEnabled,
  pollDisabled,
  WORKSPACE,
  captureDeviceRuntimeUiProof,
  captureEnvironmentMetadataUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const updateIssue = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

function deviceEnvironment(
  id: string,
  label: string,
  details: Partial<Omit<DraftEnvironment, "id" | "type" | "label">> = {},
): DraftEnvironment {
  return { id, type: "node", label, status: "available", sessionHost: true, ...details };
}

function runtimeModel(
  id: string,
  name: string,
  provider: string,
  runtime: Omit<
    NonNullable<ModelCatalogEntry["agentRuntime"]>,
    "source" | "cloudPlacementSupported"
  >,
): ModelCatalogEntry {
  return {
    available: true,
    id,
    name,
    provider,
    agentRuntime: { ...runtime, cloudPlacementSupported: true, source: "model" },
  };
}

suite.define(() => {
  it("offers paired devices to every model whose runtime explicitly supports them", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "anthropic/claude-sonnet-4-6",
        models: [
          runtimeModel("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", {
            id: "openclaw",
            devicePlacementSupported: true,
            devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
          }),
          runtimeModel("gpt-5.6-sol", "GPT-5.6 Sol", "openai", {
            id: "codex",
            devicePlacementSupported: true,
            devicePlacement: {
              requiredNodeCommands: ["codex.exec-server.stdio.v1"],
              consumesWorkerSlot: false,
            },
          }),
          runtimeModel("claude-opus-4-6", "Claude Opus 4.6", "anthropic", {
            id: "cloud-only",
            devicePlacementSupported: false,
          }),
        ],
        methodResponses: {
          "environments.list": {
            environments: [
              deviceEnvironment("node:build-mac", "Build Mac", {
                workerSlots: { total: 2, available: 0 },
                capabilities: ["codex.exec-server.stdio.v1"],
                invocableCommands: ["codex.exec-server.stdio.v1"],
                requiredNodeCommand: {
                  command: "codex.exec-server.stdio.v1",
                  state: "invocable",
                },
              }),
              deviceEnvironment("node:restricted-mac", "Restricted Mac", {
                workerSlots: { total: 2, available: 1 },
                capabilities: ["codex.exec-server.stdio.v1"],
                invocableCommands: [],
                requiredNodeCommand: {
                  command: "codex.exec-server.stdio.v1",
                  state: "unauthorized",
                },
              }),
            ],
            profiles: [],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("models.list");
      await gateway.waitForRequest("environments.list");
      const whereTrigger = page.locator("#new-session-where-trigger");
      const where = page.locator(".oc-popover.new-session-page__where-popover");
      const device = where.locator('[data-value="device:build-mac"]');
      const restrictedDevice = where.locator('[data-value="device:restricted-mac"]');
      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await whereTrigger.click();
      await device.waitFor();
      expect(await device.isDisabled()).toBe(true);
      expect(await tooltipTitleText(device)).toBe(
        "No worker slots are available. Wait for a slot or pick another device.",
      );
      expect(await restrictedDevice.isEnabled()).toBe(true);
      await captureDeviceRuntimeUiProof(suite, page, "01-embedded-device-capacity-gated.png");
      await page.keyboard.press("Escape");
      await modelSelect.click();
      await selectChatModelOption(page.locator('[data-chat-model-option="openai/gpt-5.6-sol"]'));
      await pollText(modelSelect).toContain("GPT-5.6 Sol");
      await whereTrigger.click();
      await pollEnabled(device).toBe(true);
      await pollDisabled(restrictedDevice).toBe(true);
      await expect
        .poll(async () =>
          (await gateway.getRequests("environments.list")).map((request) => request.params),
        )
        .toContainEqual({ runtimeId: "codex" });
      await expect
        .poll(() => tooltipTitleText(restrictedDevice))
        .toBe(
          "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.",
        );
      await captureDeviceRuntimeUiProof(
        suite,
        page,
        "02-codex-zero-slot-enabled-denied-command-disabled.png",
      );
      await page.keyboard.press("Escape");
      await modelSelect.click();
      await selectChatModelOption(
        page.locator('[data-chat-model-option="anthropic/claude-opus-4-6"]'),
      );
      await pollText(modelSelect).toContain("Claude Opus 4.6");
      await whereTrigger.click();
      await pollDisabled(device).toBe(true);
      expect(await device.locator(".session-menu__description").count()).toBe(0);
      await expect
        .poll(() => tooltipTitleText(device))
        .toBe("This runtime does not support paired devices");
      await captureDeviceRuntimeUiProof(suite, page, "03-cloud-only-device-disabled.png");
      await page.keyboard.press("Escape");
      await modelSelect.click();
      await selectChatModelOption(
        page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]'),
      );
      await whereTrigger.click();
      await pollDisabled(device).toBe(true);
      await pollEnabled(restrictedDevice).toBe(true);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
    });
  });

  it("renders authoritative device eligibility and exact live capacity", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [
              { id: "gateway", type: "local", status: "available", sessionHost: true },
              deviceEnvironment("node:alpha-device", "Build runner", {
                platform: "darwin",
                workerSlots: { total: 4, available: 2 },
                capabilities: ["camera.snap", "screen.record"],
              }),
              deviceEnvironment("node:beta-device", "Build runner", {
                workerSlots: { total: 2, available: 1 },
              }),
              deviceEnvironment("node:saturated", "Already busy runner", {
                workerSlots: { total: 2, available: 0 },
              }),
              deviceEnvironment("node:missing-capacity", "Capacity unknown"),
              deviceEnvironment("node:offline", "Offline runner", {
                status: "unavailable",
                lastConnectedAtMs: 1_000,
                lastDisconnectedAtMs: 4_000,
              }),
              deviceEnvironment("node:disabled", "Hosting disabled", { sessionHost: false }),
              deviceEnvironment("node:outdated", "Outdated runner", {
                workerSlots: { total: 1, available: 1 },
                issues: [updateIssue],
              }),
            ],
            profiles: [{ id: "ephemeral", providerId: "crabbox", trust: "disposable" }],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const place = page.locator(".oc-popover.new-session-page__where-popover");
      await openEnvironmentPicker(page);
      const row = (id: string) => place.locator(`[data-value="device:${id}"]`);
      await row("alpha-device").waitFor();
      await captureEnvironmentMetadataUiProof(suite, page);
      expect(await row("alpha-device").isEnabled()).toBe(true);
      const details = (id: string) =>
        row(id).locator("xpath=ancestor::openclaw-tooltip[1]").locator('[slot="content"]');
      await row("alpha-device").hover();
      await pollText(details("alpha-device")).toContain("macOS");
      expect(await details("alpha-device").textContent()).toContain("2 of 4 session slots in use");
      expect(await row("alpha-device").locator(".session-menu__description").count()).toBe(0);
      expect(await row("saturated").isDisabled()).toBe(true);
      await row("saturated").hover();
      await pollText(details("saturated")).toContain(
        "No worker slots are available. Wait for a slot or pick another device.",
      );
      expect(
        await details("saturated").locator(".new-session-page__capacity-caption").count(),
      ).toBe(0);
      expect(await row("missing-capacity").isDisabled()).toBe(true);
      expect(await row("offline").isDisabled()).toBe(true);
      expect(await row("offline").locator(".session-menu__description").count()).toBe(0);
      expect(
        await row("offline")
          .locator("..")
          .evaluate((element) => element.tagName),
      ).not.toBe("OPENCLAW-TOOLTIP");
      expect(await row("disabled").isDisabled()).toBe(true);
      expect(await row("outdated").isDisabled()).toBe(true);
      const selectedRow = row("alpha-device");
      const selectionLayout = () =>
        selectedRow.evaluate((element) =>
          [
            element,
            ...[".session-menu__text", ".session-menu__check"].map((selector) => {
              const part = element.querySelector(selector);
              if (!part) {
                throw new Error(`Missing environment row part: ${selector}`);
              }
              return part;
            }),
          ].map((part) => {
            const { x, width } = part.getBoundingClientRect();
            return { x, width };
          }),
        );
      await selectedRow.hover();
      const beforeSelection = await selectionLayout();
      expect(beforeSelection.every(({ width }) => width > 0)).toBe(true);
      expect(await selectedRow.locator(".session-menu__check svg").count()).toBe(0);
      await selectedRow.click();
      await selectedRow.waitFor({ state: "hidden" });
      await openEnvironmentPicker(page);
      await selectedRow.hover();
      expect(await selectedRow.getAttribute("aria-pressed")).toBe("true");
      expect(await details("alpha-device").textContent()).toContain("2 of 4 session slots in use");
      expect(await selectedRow.locator(".session-menu__check svg").isVisible()).toBe(true);
      expect(await selectionLayout()).toEqual(beforeSelection);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      const beforeRefresh = (await gateway.getRequests("environments.list")).length;
      await gateway.emitGatewayEvent("presence", {
        presence: [{ instanceId: "other-browser", mode: "webchat", roles: ["operator"] }],
      });
      await page.locator("openclaw-new-session-page").evaluate(async (element) => {
        await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
      });
      expect(await gateway.getRequests("environments.list")).toHaveLength(beforeRefresh);
      expect(await selectedRow.isEnabled()).toBe(true);
      const catalog = (
        status: "available" | "unavailable",
        available: number,
        label = "Build runner",
      ) => ({
        environments: [
          deviceEnvironment("node:alpha-device", label, {
            status,
            workerSlots: { total: 4, available },
          }),
        ],
        profiles: [],
      });
      const selectedControl = await selectedRow.elementHandle();
      if (!selectedControl) {
        throw new Error("Selected device control is unavailable");
      }
      await page.keyboard.press("Tab");
      await selectedRow.focus();
      await gateway.deferNext("environments.list");
      await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "alpha-device" });
      await gateway.waitForRequest("environments.list", { after: beforeRefresh });
      for (let index = 0; index < 31; index += 1) {
        await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "alpha-device" });
      }
      expect(await gateway.getRequests("environments.list")).toHaveLength(beforeRefresh + 1);
      await pollDisabled(selectedRow).toBe(true);
      await captureDeviceRuntimeUiProof(suite, page, "04-device-refresh-focus.png");
      expect(
        await selectedControl.evaluate((element) => ({
          connected: element.isConnected,
          focused: element === document.activeElement,
          device: element.getAttribute("data-value"),
        })),
      ).toEqual({ connected: true, focused: true, device: "device:alpha-device" });
      await page.keyboard.press("Enter");
      expect(await place.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      expect(await selectedRow.getAttribute("aria-pressed")).toBe("true");
      for (let cycle = 1; cycle <= 4; cycle += 1) {
        await gateway.deferNext("environments.list");
        await gateway.resolveDeferred(
          "environments.list",
          catalog("available", 2, `Build runner ${cycle}`),
        );
        await gateway.waitForRequest("environments.list", { after: beforeRefresh + cycle });
        await pollText(selectedRow).toContain(`Build runner ${cycle}`);
        expect(await gateway.getRequests("environments.list")).toHaveLength(
          beforeRefresh + cycle + 1,
        );
        expect(await selectedRow.isDisabled()).toBe(true);
        if (cycle < 4) {
          for (let index = 0; index < 8; index += 1) {
            await gateway.emitGatewayEvent("node.runnerInventory.changed", {
              nodeId: "alpha-device",
            });
          }
        }
      }
      await gateway.resolveDeferred("environments.list", catalog("available", 0));
      await selectedRow.hover();
      await pollText(details("alpha-device")).toContain("No worker slots are available");
      expect(await selectedRow.getAttribute("aria-pressed")).toBe("true");
      expect(await selectedControl.evaluate((element) => element.isConnected)).toBe(true);
      await selectedControl.dispose();
      for (const connected of [false, true]) {
        const previousRequests = (await gateway.getRequests("environments.list")).length;
        await gateway.setMethodResponse(
          "environments.list",
          catalog(connected ? "available" : "unavailable", 4),
        );
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              deviceId: "alpha-device",
              mode: "node",
              roles: ["node"],
              reason: connected ? "connect" : "disconnect",
            },
          ],
        });
        await gateway.waitForRequest("environments.list", { after: previousRequests });
        await pollEnabled(selectedRow).toBe(connected);
      }
      for (const sessionHost of [false, true]) {
        const previousRequests = (await gateway.getRequests("environments.list")).length;
        const next = catalog("available", 4);
        next.environments[0]!.sessionHost = sessionHost;
        await gateway.setMethodResponse("environments.list", next);
        await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "alpha-device" });
        await gateway.waitForRequest("environments.list", { after: previousRequests });
        await pollEnabled(selectedRow).toBe(sessionHost);
      }
    });
  });
});
