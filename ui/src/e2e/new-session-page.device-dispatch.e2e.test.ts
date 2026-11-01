import path from "node:path";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CLOUD_PROFILE_RETRY_DELAYS_MS } from "../pages/new-session/cloud-profile-discovery.ts";
import {
  pollAttribute,
  pollText,
  pollValue,
  pollEnabled,
  pollDisabled,
  WORKSPACE,
  captureDeviceRuntimeUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const deviceTargets = [
  { name: "selected", value: "device:paired-runner", target: { deviceId: "paired-runner" } },
  { name: "automatic", value: "auto-device", target: { autoDevice: true } },
];
const gitRepository = {
  branches: [{ kind: "local", name: "main" }],
  defaultBranch: "main",
  repositoryStatus: "git",
};

const pairedRunner = (status = "available", available = 1) => ({
  id: "node:paired-runner",
  type: "node",
  label: "Paired runner",
  status,
  sessionHost: true,
  workerSlots: { total: 2, available },
});
const offlineRunner = () => ({
  id: "node:offline-runner",
  type: "node",
  label: "Offline runner",
  status: "unavailable",
  sessionHost: true,
});
const deviceEnvironments = () => [pairedRunner(), offlineRunner()];
const busyRunner = () => ({
  ...pairedRunner("available", 0),
  id: "node:offline-runner",
  label: "Offline runner",
});

function rememberedTarget(kind: "device" | "auto-device" | "cloud", id?: string) {
  return {
    preference: { kind, ...(id ? { id } : {}) },
    attribute: `data-${kind === "cloud" ? "cloud-profile" : kind === "device" ? "device-id" : kind}`,
    value: id ?? "true",
    target: {
      [kind === "device" ? "deviceId" : kind === "cloud" ? "profileId" : "autoDevice"]: id ?? true,
    },
  };
}

async function openDevicePage(
  page: Page,
  scenario: NonNullable<Parameters<typeof installMockGateway>[1]>,
) {
  const gateway = await installMockGateway(page, {
    operatorScopes: ["operator.read", "operator.write"],
    workspace: WORKSPACE,
    workspaceGit: true,
    ...scenario,
    methodResponses: {
      "environments.list": { environments: deviceEnvironments(), profiles: [] },
      ...scenario.methodResponses,
    },
  });
  await page.goto(`${suite.server.baseUrl}new`);
  await gateway.waitForRequest("environments.list");
  return gateway;
}

async function rememberDestination(
  page: Page,
  preference: { kind: string; id?: string },
  agentId = "main",
  isolated = true,
) {
  const url = new URL(suite.server.baseUrl);
  const gatewayUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
  await page.addInitScript(
    ({ key, workspace, where, agent, worktree }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ agents: { [agent]: { workspace, folder: workspace, where, worktree } } }),
      );
    },
    {
      key: storageKey,
      workspace: WORKSPACE,
      where: preference,
      agent: agentId,
      worktree: isolated,
    },
  );
}

suite.define(() => {
  it("groups environments and selects Auto before named devices", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const trigger = page.locator("#new-session-where-trigger");
      await openDevicePage(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        methodResponses: {
          "environments.list": {
            environments: deviceEnvironments(),
            profiles: [{ id: "aws", providerId: "aws" }],
          },
        },
      });
      await trigger.click();
      const picker = page.locator(".new-session-page__where-popover");
      const destinations = picker.locator(".new-session-page__environment-list");
      await expect
        .poll(() =>
          destinations
            .locator("[data-value]")
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-value")),
            ),
        )
        .toEqual([
          "auto-device",
          "gateway",
          "device:paired-runner",
          "device:offline-runner",
          "cloud:aws",
        ]);
      expect(
        await picker
          .locator(".new-session-page__environment-heading")
          .allTextContents()
          .then((headings) => headings.map((heading) => heading.replace(/\s+/g, " ").trim())),
      ).toEqual(["Your devices", "Hosted workspaces", "Cloud"]);
      const auto = destinations.locator('[data-value="auto-device"]');
      expect(await auto.getAttribute("aria-pressed")).toBe("false");
      expect(await destinations.getByRole("button", { name: /^aws(?: · .+)?$/ }).count()).toBe(1);
      await auto.click();

      await pollAttribute(trigger, "data-auto-device").toBe("true");
      await trigger.click();
      await pollAttribute(auto, "aria-pressed").toBe("true");
      await destinations.locator('[data-value="device:paired-runner"]').click();
      await pollAttribute(trigger, "data-device-id").toBe("paired-runner");
      expect(await trigger.getAttribute("data-auto-device")).toBeNull();
      await trigger.click();
      expect(await auto.getAttribute("aria-pressed")).toBe("false");
      expect(
        await destinations
          .locator('[data-value="device:paired-runner"]')
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
  });

  it.each(deviceTargets)("dispatches the $name device", async ({ value, target }) => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:device-dispatch";
      const gateway = await openDevicePage(page, {
        methodResponses: {
          "environments.list": {
            environments: [
              {
                id: "gateway",
                type: "local",
                label: "Gateway local",
                status: "available",
                sessionHost: true,
              },
              pairedRunner(),
              offlineRunner(),
            ],
            profiles: [],
          },
          "sessions.create": { key: sessionKey },
          "worktrees.branches": gitRepository,
          "sessions.list": createdSessionListResult(sessionKey),
          "sessions.dispatch": {
            ok: true,
            key: sessionKey,
            sessionId: `session:${sessionKey}`,
            placement: { state: "active", generation: 1 },
          },
          "sessions.describe": {
            session: {
              sessionId: `session:${sessionKey}`,
              placement: { state: "requested", generation: 1 },
            },
          },
          "chat.send": { runId: "run-device-dispatch", status: "started" },
        },
      });
      await page.locator("#new-session-where-trigger").click();
      await page.locator(`[data-value="${value}"]`).click();
      await page.locator(".new-session-page__message").fill("run on the paired device");
      expect(await page.locator('[data-value="start-terminal"]').count()).toBe(0);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "",
        worktree: true,
        worktreeSource: "empty",
      });
      expect(create.params).not.toHaveProperty("execNode");
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({
        key: sessionKey,
        agentId: "main",
        ...target,
      });
      const send = await gateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({
        sessionKey,
        sessionId: `session:${sessionKey}`,
        expectedLeafEntryId: null,
        message: "run on the paired device",
      });
      const requests = await gateway.getRequests();
      expect(requests.findIndex((request) => request.id === create.id)).toBeLessThan(
        requests.findIndex((request) => request.id === dispatch.id),
      );
      expect(requests.findIndex((request) => request.id === dispatch.id)).toBeLessThan(
        requests.findIndex((request) => request.id === send.id),
      );
    });
  });

  it.each(deviceTargets)(
    "does not dispatch the $name device from stale capacity during a failed topology refresh",
    async ({ value }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          ...(process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? { recordVideo: { dir: path.join(suite.artifactDir, "device-runtime-gating") } }
            : {}),
        },
        async ({ page }) => {
          const environment = pairedRunner();
          const gateway = await openDevicePage(page, {
            methodResponses: {
              "environments.list": {
                environments: [environment, busyRunner()],
                profiles: [],
              },
              "sessions.create": { key: "agent:main:stale-device-capacity" },
              "worktrees.branches": gitRepository,
            },
          });
          const where = page.locator("#new-session-where-trigger");
          await where.click();
          await page.locator(`[data-value="${value}"]`).click();
          await page.locator(".new-session-page__message").fill("require current worker capacity");
          const start = page.getByRole("button", { name: "Start session" });
          await pollEnabled(start).toBe(true);
          await where.click();
          const selectedDevice = page.locator('[data-value="device:paired-runner"]');
          const automaticDevice = page.locator('[data-value="auto-device"]');
          const localDevice = page.locator('[data-value="gateway"]');
          await selectedDevice.waitFor({ state: "visible" });
          const clockTime = Date.now();
          await page.clock.install({ time: clockTime });
          await page.clock.pauseAt(clockTime + 1_000);
          await gateway.deferNext("environments.list");
          const requestsBeforeRefresh = (await gateway.getRequests("environments.list")).length;
          await gateway.emitGatewayEvent("node.runnerInventory.changed", {
            nodeId: "paired-runner",
          });
          await gateway.waitForRequest("environments.list", { after: requestsBeforeRefresh });
          await pollDisabled(start).toBe(true);
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          await pollAttribute(
            where,
            value === "auto-device" ? "data-auto-device" : "data-device-id",
          ).toBe(value === "auto-device" ? "true" : "paired-runner");
          await gateway.rejectDeferred("environments.list", {
            code: "UNAVAILABLE",
            message: "worker inventory is temporarily unavailable",
          });
          await page.clock.runFor(CLOUD_PROFILE_RETRY_DELAYS_MS[0] - 1);
          expect(await gateway.getRequests("environments.list")).toHaveLength(
            requestsBeforeRefresh + 1,
          );
          await captureDeviceRuntimeUiProof(
            suite,
            page,
            `failed-topology-${value.replace(":", "-")}.png`,
            {
              surface: page.locator(".oc-popover.new-session-page__where-popover"),
              content: [selectedDevice, automaticDevice],
            },
          );
          expect(await start.isDisabled()).toBe(true);
          expect(await selectedDevice.isDisabled()).toBe(true);
          expect(await automaticDevice.isDisabled()).toBe(value !== "auto-device");
          expect(await localDevice.isEnabled()).toBe(true);
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          await gateway.deferNext("environments.list");
          await page.clock.runFor(1);
          await gateway.waitForRequest("environments.list", { after: requestsBeforeRefresh + 1 });
          await gateway.resolveDeferred("environments.list", {
            environments: [pairedRunner("available", 0), busyRunner()],
            profiles: [],
          });
          await pollDisabled(start).toBe(true);
          await pollAttribute(start.locator("xpath=.."), "content").toContain(
            "No worker slots are available",
          );
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          await page.clock.resume();
          await gateway.emitGatewayEvent("node.runnerInventory.changed", {
            nodeId: "paired-runner",
          });
          await gateway.waitForRequest("environments.list", { after: requestsBeforeRefresh + 2 });
          await pollEnabled(start).toBe(true);
          expect(await selectedDevice.isEnabled()).toBe(true);
          expect(await automaticDevice.isEnabled()).toBe(true);
        },
      );
    },
  );

  it.each([
    { name: "paired device", ...rememberedTarget("device", "paired-runner") },
    { name: "automatic device", ...rememberedTarget("auto-device") },
    { name: "cloud worker", ...rememberedTarget("cloud", "aws") },
  ])(
    "does not start locally while a remembered $name destination is being restored",
    async ({ preference, attribute, value, target }) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        if (preference.kind === "cloud") {
          // Recovery hydration must neither restart the catalog nor fall back to Local.
          await page.addInitScript(() => {
            const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
            const delayed = new Promise<void>((resolve) => {
              window.addEventListener("test-release-recovery-scope", () => resolve(), {
                once: true,
              });
            });
            crypto.subtle.digest = async (algorithm, data) => {
              if (new TextDecoder().decode(data) === "e2e-device-token") {
                await delayed;
              }
              return originalDigest(algorithm, data);
            };
          });
        }

        const sessionKey = "agent:main:restored-remote-destination";
        const catalog = {
          environments: deviceEnvironments(),
          profiles: [{ id: "aws", providerId: "crabbox" }],
        };
        await rememberDestination(page, preference);
        const gateway = await openDevicePage(page, {
          heldMethods: ["environments.list"],
          operatorScopes: ["operator.read", "operator.write", "operator.admin"],
          methodResponses: {
            "environments.list": catalog,
            "worktrees.branches": gitRepository,
            "sessions.create": { key: sessionKey },
            "sessions.list": createdSessionListResult(sessionKey),
            "sessions.dispatch": {
              sessionId: `session:${sessionKey}`,
              placement: { state: "active", generation: 1 },
            },
            "chat.send": { runId: "run-restored-remote", status: "started" },
          },
        });
        await pollAttribute(page.locator("#new-session-checkout-trigger"), "data-worktree").toBe(
          "false",
        );
        if (preference.kind === "cloud") {
          await page.evaluate(() => {
            window.dispatchEvent(new Event("test-release-recovery-scope"));
          });
          await waitForGatewayRecoveryScope(page);
          expect(await gateway.getRequests("environments.list")).toHaveLength(1);
        }
        await page.locator(".new-session-page__message").fill("keep my chosen remote destination");
        const start = page.getByRole("button", { name: "Start session" });
        await pollDisabled(start).toBe(true);
        await pollAttribute(start.locator("xpath=.."), "content").toContain(
          "Restoring your last session setup",
        );
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        await gateway.resolveDeferred("environments.list");
        const where = page.locator("#new-session-where-trigger");
        await pollAttribute(where, attribute).toBe(value);
        await pollEnabled(start).toBe(true);
        await start.click();
        await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
          params: { worktree: true },
        });
        await expect(gateway.waitForRequest("sessions.dispatch")).resolves.toMatchObject({
          params: { key: sessionKey, agentId: "main", ...target },
        });
      });
    },
  );

  it.each([
    {
      name: "offline paired device",
      ...rememberedTarget("device", "paired-runner"),
      status: "unavailable",
      availableSlots: 1,
      reason: "Device unavailable",
    },
    {
      name: "automatic device without worker capacity",
      ...rememberedTarget("auto-device"),
      status: "available",
      availableSlots: 0,
      reason: "No worker slots are available",
    },
  ])(
    "keeps a remembered $name blocked until the user explicitly switches to Local",
    async ({ preference, status, availableSlots, attribute, value, reason }) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const sessionKey = "agent:main:explicit-local-choice";
        await rememberDestination(page, preference);
        const gateway = await openDevicePage(page, {
          methodResponses: {
            "environments.list": {
              environments: [pairedRunner(status, availableSlots)],
              profiles: [],
            },
            "sessions.create": { key: sessionKey },
            "sessions.list": createdSessionListResult(sessionKey),
          },
        });
        const where = page.locator("#new-session-where-trigger");
        await pollAttribute(where, attribute).toBe(value);
        await page.locator(".new-session-page__message").fill("run only where I choose");
        const start = page.getByRole("button", { name: "Start session" });
        await pollDisabled(start).toBe(true);
        await pollAttribute(start.locator("xpath=.."), "content").toContain(reason);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        await where.click();
        const local = page.locator('[data-value="gateway"]');
        expect(await local.isEnabled()).toBe(true);
        await local.click();
        await pollAttribute(where, "data-auto-device").toBeNull();
        await pollAttribute(where, "data-device-id").toBeNull();
        await pollEnabled(start).toBe(true);
        await start.click();
        await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
          params: { agentId: "main", message: "run only where I choose" },
        });
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      });
    },
  );

  it("restores the selected agent's own destination instead of inheriting another agent's device", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:research:local-after-agent-switch";
      await rememberDestination(page, { kind: "local" }, "research", false);
      const gateway = await openDevicePage(page, {
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", workspace: WORKSPACE, workspaceGit: true },
              { id: "research", workspace: WORKSPACE, workspaceGit: true },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });
      const where = page.locator("#new-session-where-trigger");
      await where.click();
      await page.locator('[data-value="device:paired-runner"]').click();
      await pollAttribute(where, "data-device-id").toBe("paired-runner");
      await captureDeviceRuntimeUiProof(suite, page, "01-main-agent-paired-node-selected.png");
      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("option", { name: "research", exact: true }).click();
      await pollText(agentPicker.locator(".agent-select__label")).toBe("research");
      await pollAttribute(where, "data-device-id").toBeNull();
      await pollText(where.locator(".new-session-page__trigger-label")).toBe("Local");
      await captureDeviceRuntimeUiProof(
        suite,
        page,
        "02-research-agent-local-destination-restored.png",
      );
      const message = "run this agent locally";
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ agentId: "research", message });
      expect(create.params).not.toHaveProperty("worktree");
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each(deviceTargets)(
    "reloads a pending empty-workspace create with the same $name device target",
    async ({ value, target }) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const message = "resume on the paired device";
        const gateway = await openDevicePage(page, {
          deferredMethods: ["sessions.create"],
          operatorScopes: undefined,
          workspaceGit: false,
          methodResponses: {
            "chat.send": { runId: "run-device-recovery", status: "started" },
          },
        });
        await page.locator("#new-session-where-trigger").click();
        await page.locator(`[data-value="${value}"]`).click();
        await page.locator(".new-session-page__message").fill(message);
        await page.getByRole("button", { name: "Start session" }).click();
        const firstCreate = await gateway.waitForRequest("sessions.create");
        expect(firstCreate.params).toMatchObject({ worktree: true, worktreeSource: "empty" });
        const sessionKey = (firstCreate.params as { key?: string }).key;
        if (!sessionKey) {
          throw new Error("expected a recoverable device create key");
        }
        await page.reload();
        await gateway.waitForRequest("environments.list");
        await pollAttribute(
          page.locator("#new-session-where-trigger"),
          value === "auto-device" ? "data-auto-device" : "data-device-id",
        ).toBe(value === "auto-device" ? "true" : "paired-runner");
        await pollValue(page.locator(".new-session-page__message")).toBe(message);
        await pollText(page.locator("#new-session-project-trigger")).toContain("New workspace");
        expect(await page.locator("#new-session-checkout-trigger").count()).toBe(0);
        await page.getByRole("button", { name: "Start session" }).click();
        const retryCreate = await gateway.waitForRequest("sessions.create");
        expect(retryCreate.params).toMatchObject({
          key: sessionKey,
          message: "",
          worktree: true,
          worktreeSource: "empty",
        });
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        await gateway.deferNext("sessions.dispatch");
        await gateway.resolveDeferred("sessions.create", { key: sessionKey });
        await expect(gateway.waitForRequest("sessions.dispatch")).resolves.toMatchObject({
          params: { key: sessionKey, agentId: "main", ...target },
        });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.dispatch", {
          sessionId: `session:${sessionKey}`,
          placement: { state: "active", generation: 1 },
        });
        await expect(gateway.waitForRequest("chat.send")).resolves.toMatchObject({
          params: {
            sessionKey,
            sessionId: `session:${sessionKey}`,
            expectedLeafEntryId: null,
            agentId: "main",
            message,
          },
        });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
          timeout: 30_000,
        });
      });
    },
  );
});
