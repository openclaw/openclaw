import type { Locator } from "playwright";
import { expect, it, onTestFinished } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { holdModuleResponse } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const machineName = "Studio Mac";
const nodeEnvironment = (id: string, label: string, available: number) => ({
  id: `node:${id}`,
  type: "node",
  label,
  status: "available",
  sessionHost: true,
  workerSlots: { total: 1, available },
});
const remoteSession = {
  key: "agent:main:environment-device",
  sessionId: "environment-device-session",
  kind: "direct",
  label: "Review device environment",
  spawnedCwd: "/repo/project",
  updatedAt: 2,
  placement: {
    state: "active",
    generation: 2,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId: "node:studio",
    activeOwnerEpoch: 1,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "base-manifest",
    remoteWorkspaceDir: "/worker/project",
    runner: { kind: "device", status: "available", deviceId: "studio" },
  },
} satisfies GatewaySessionRow;
async function settleMotion(host: Locator) {
  await host.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

suite.define(() => {
  it("cancels pending mobile Machine loading and returns to Details after reopening", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true, locale: "en-US" },
      async ({ page }) => {
        const module = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-machine.tsx"),
        );
        onTestFinished(module.release);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const offlineSession = {
          ...remoteSession,
          placement: {
            ...remoteSession.placement,
            runner: { ...remoteSession.placement.runner, status: "offline" as const },
          },
        };
        const gateway = await installMockGateway(page, {
          sessionKey: remoteSession.key,
          sessionInfo: offlineSession,
          featureMethods: ["environments.list"],
          methodResponses: {
            "sessions.list": chatSessionListResponse([offlineSession]),
            "environments.list": {
              profiles: [],
              environments: [nodeEnvironment("studio", machineName, 0)],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, remoteSession.key));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const header = pane.locator(".agent-chat__header--mobile");
        await header
          .getByRole("button", { name: remoteSession.label + " — Details", exact: true })
          .waitFor();
        await gateway.waitForRequest("environments.list");
        const host = pane.locator(".chat-mobile-host");
        const environment = host.locator(".chat-environment-mobile");
        const machine = environment.getByRole("button", { name: machineName, exact: true });
        expect(module.requests()).toBe(0);
        await header.getByRole("button", { name: /Studio Mac.*Offline/i }).click();
        const moduleUrl = await module.request;
        await host.getByRole("status", { name: "Loading…", exact: true }).waitFor();
        await host.getByRole("button", { name: "Back", exact: true }).click();
        await host.getByRole("button", { name: "Close", exact: true }).click();
        await host.waitFor({ state: "hidden" });
        module.release();
        // Observe the pending native import without reopening its dismissed destination.
        await page.evaluate(`import(${JSON.stringify(moduleUrl)}).then(() => undefined)`);
        expect(await host.isVisible()).toBe(false);
        expect(errors).toEqual([]);
        await header
          .getByRole("button", { name: remoteSession.label + " — Details", exact: true })
          .click();
        await machine.click();
        await host
          .locator(".chat-machine__identity")
          .getByText(machineName, { exact: true })
          .waitFor();
        await host.getByRole("button", { name: "Back", exact: true }).click();
        await machine.waitFor();
        expect(
          await host
            .getByRole("button", { name: "Details", exact: true })
            .getAttribute("aria-pressed"),
        ).toBe("true");
        await host.getByRole("button", { name: "Close", exact: true }).click();

        expect(await gateway.getRequests("environments.list")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
        expect(module.requests()).toBe(1);
        expect(errors).toEqual([]);
      },
    );
  });

  it("expands and restores the mobile Machine move picker without losing its selected target", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: remoteSession.key,
          sessionInfo: remoteSession,
          operatorScopes: ["operator.read", "operator.write"],
          featureMethods: ["environments.list", "sessions.move"],
          methodResponses: {
            "sessions.list": chatSessionListResponse([remoteSession]),
            "environments.list": {
              profiles: [],
              environments: [
                nodeEnvironment("studio", machineName, 0),
                nodeEnvironment("spare", "Spare Mac", 1),
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, remoteSession.key));
        const pane = page.locator(".chat-pane-cache__pane--active");
        await pane
          .getByRole("button", { name: remoteSession.label + " — Details", exact: true })
          .click();
        const host = pane.locator(".chat-mobile-host");
        await host
          .locator(".chat-environment-mobile")
          .getByRole("button", { name: machineName, exact: true })
          .click();
        await host.getByRole("button", { name: "Move session", exact: true }).click();
        const picker = host.locator(".session-move--inline");
        const destination = picker.getByRole("radio", { name: /^Spare Mac/ });
        await destination.click();
        expect(await destination.getAttribute("aria-checked")).toBe("true");
        expect(await page.locator("openclaw-modal-dialog[open]").count()).toBe(0);
        const header = host.locator(".chat-mobile-host__header");
        const expand = header.getByRole("button", { name: "Expand Side panel", exact: true });
        expect(await expand.count()).toBe(1);
        const dockedHeight = await host.evaluate(
          (element) => element.getBoundingClientRect().height,
        );
        await expand.click();
        await pane.locator('.chat-mobile-host[data-mode="expanded"]').waitFor();
        await settleMotion(host);
        expect(
          await host.evaluate((element) => element.getBoundingClientRect().height),
        ).toBeGreaterThan(dockedHeight + 100);
        expect(await destination.getAttribute("aria-checked")).toBe("true");
        await header.getByRole("button", { name: "Restore", exact: true }).click();
        await pane.locator('.chat-mobile-host[data-mode="dock"]').waitFor();
        await settleMotion(host);
        expect(
          Math.abs(
            (await host.evaluate((element) => element.getBoundingClientRect().height)) -
              dockedHeight,
          ),
        ).toBeLessThan(1);
        expect(await destination.getAttribute("aria-checked")).toBe("true");
        await header.getByRole("button", { name: "Back", exact: true }).click();
        await host
          .locator(".chat-machine__identity")
          .getByText(machineName, { exact: true })
          .waitFor();
        expect(await gateway.getRequests("sessions.move")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
      },
    );
  });
});
