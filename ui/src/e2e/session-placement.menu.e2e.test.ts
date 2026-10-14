import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:menu-placement";
const label = "Review release notes";
function localSession() {
  return {
    key: sessionKey,
    sessionId: "menu-placement-1",
    kind: "direct",
    label,
    updatedAt: Date.now(),
    status: "done",
    hasActiveRun: false,
    worktree: { id: "notes-workspace", branch: "release-notes", repoRoot: "/example/project" },
  };
}
function remoteSession() {
  return {
    ...localSession(),
    placement: {
      state: "active" as const,
      generation: 4,
      createdAtMs: Date.now() - 30_000,
      updatedAtMs: Date.now() - 5_000,
      stateChangedAtMs: Date.now() - 5_000,
      environmentId: "worker:notes",
      activeOwnerEpoch: 7,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "notes-base",
      remoteWorkspaceDir: "/workspace/notes",
    },
  };
}
const catalog = {
  profiles: [{ id: "cloud", providerId: "crabbox", providerDisplayId: "aws" }],
  environments: [
    {
      id: "node:runner",
      type: "node",
      label: "Build device",
      status: "available",
      sessionHost: true,
      workerSlots: { total: 1, available: 1 },
    },
    {
      id: "node:offline",
      type: "node",
      label: "Offline device",
      status: "unavailable",
      sessionHost: true,
    },
  ],
};
type Surface = "sidebar" | "sessions" | "header";
async function openMenu(page: Page, surface: Surface) {
  if (surface === "header") {
    await page.getByRole("button", { name: "Actions for " + label }).click();
    return page.locator("openclaw-chat-header-session-menu");
  }
  if (surface === "sidebar") {
    const coding = page
      .locator('[data-session-section="work"] .sidebar-session-group-toggle')
      .first();
    if ((await coding.getAttribute("aria-expanded")) === "false") {
      await coding.click();
    }
  }
  const row =
    surface === "sidebar"
      ? page.locator('openclaw-app-sidebar [data-session-key="' + sessionKey + '"]')
      : page.locator("openclaw-sessions-page tr").filter({ hasText: label });
  await row.click({ button: "right" });
  return page.locator("openclaw-session-menu");
}

suite.define(() => {
  it.each(["sidebar", "sessions", "header"] as const)(
    "moves local to remote and back through the %s menu",
    async (surface) => {
      const context = await suite.newBrowserContext({
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.startup",
          "sessions.patch",
          "sessions.dispatch",
          "sessions.move",
          "environments.list",
        ],
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        sessionKey,
        historyMessages: [
          { role: "assistant", content: "The release notes are ready for review." },
        ],
        methodResponses: {
          "sessions.list": chatSessionListResponse([localSession()]),
          "environments.list": catalog,
        },
      });
      try {
        await page.goto(
          surface === "sessions"
            ? suite.server.baseUrl + "sessions"
            : controlUiSessionUrl(suite.server.baseUrl, sessionKey),
        );
        const menu = await openMenu(page, surface);
        const action = menu.getByText("Move to cloud…", { exact: true });
        await action.waitFor();
        const proof =
          surface === "sidebar" && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? createControlUiE2eArtifactDir("session-placement-menu")
            : undefined;
        if (proof) {
          const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [action], {
            animations: "disabled",
          });
          await writeFile(path.join(proof, "after-local-context-menu.png"), frame.png);
        }
        await action.click();
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.locator('[data-value="device:runner"]').waitFor();
        expect(await dialog.locator('[data-value="gateway"]').count()).toBe(0);
        expect(await dialog.locator('[data-value="device:offline"]').isDisabled()).toBe(true);
        await gateway.deferNext("sessions.dispatch");
        const device = surface === "sessions";
        await dialog
          .locator(device ? '[data-value="device:runner"]' : '[data-value="cloud:cloud"]')
          .click();
        if (proof) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [dialog.getByText("Choose a worker", { exact: true }).first()],
            { animations: "disabled" },
          );
          await writeFile(path.join(proof, "after-destination-picker.png"), frame.png);
        }
        await dialog.getByRole("button", { name: "Continue on worker", exact: true }).click();
        const dispatch = await gateway.waitForRequest("sessions.dispatch");
        expect(dispatch.params).toEqual({
          key: sessionKey,
          agentId: "main",
          ...(device ? { deviceId: "runner" } : { profileId: "cloud" }),
        });
        await gateway.setSessionsListResponse(chatSessionListResponse([remoteSession()]));
        await gateway.resolveDeferred("sessions.dispatch", { ok: true });
        await gateway.emitGatewayEvent("sessions.changed", { reason: "dispatch", sessionKey });
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list")).length)
          .toBeGreaterThan(1);
        const reverseMenu = await openMenu(page, surface);
        await reverseMenu.getByText("Move session…", { exact: true }).click();
        await gateway.deferNext("sessions.move");
        await page.locator('[data-value="gateway"]').click();
        await page.getByRole("button", { name: "Move session", exact: true }).click();
        const move = await gateway.waitForRequest("sessions.move");
        expect(move.params).toEqual({
          key: sessionKey,
          agentId: "main",
          expected: { generation: 4, environmentId: "worker:notes", ownerEpoch: 7 },
          target: { kind: "gateway" },
        });
        await gateway.setSessionsListResponse(chatSessionListResponse([localSession()]));
        await gateway.resolveDeferred("sessions.move", { ok: true });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        if (surface !== "sessions") {
          expect(page.url()).toContain("menu-placement");
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("disables Move while workspace results settle and enables it after refresh", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const session = remoteSession();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.move", "environments.list"],
      operatorScopes: ["operator.admin", "operator.read", "operator.write"],
      sessionKey,
      historyMessages: [{ role: "assistant", content: "The release notes are ready for review." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            ...session,
            placement: { ...session.placement, workspaceResultReconciling: true },
          },
        ]),
        "environments.list": catalog,
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const menu = await openMenu(page, "sidebar");
      const action = menu.getByRole("menuitem", { name: "Move session…", exact: true });
      await action.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const proof = createControlUiE2eArtifactDir("session-placement-settlement");
        const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [action], {
          animations: "disabled",
        });
        await writeFile(path.join(proof, "settling-workspace-menu.png"), frame.png);
      }
      expect(await action.isDisabled()).toBe(true);
      expect(await action.getAttribute("title")).toBe("Finalizing worker workspace");
      expect(await gateway.getRequests("sessions.move")).toHaveLength(0);
      await page.keyboard.press("Escape");
      await gateway.setSessionsListResponse(chatSessionListResponse([session]));
      await gateway.emitGatewayEvent("sessions.changed", { reason: "placement", sessionKey });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(1);
      const ready = (await openMenu(page, "sidebar")).getByRole("menuitem", {
        name: "Move session…",
        exact: true,
      });
      await expect.poll(() => ready.isDisabled()).toBe(false);
      await ready.click();
      await page.locator('[data-value="gateway"]').click();
      await gateway.deferNext("sessions.move");
      await page.getByRole("button", { name: "Move session", exact: true }).click();
      expect((await gateway.waitForRequest("sessions.move")).params).toEqual({
        key: sessionKey,
        agentId: "main",
        expected: { generation: 4, environmentId: "worker:notes", ownerEpoch: 7 },
        target: { kind: "gateway" },
      });
      await gateway.resolveDeferred("sessions.move", { ok: true });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps a local busy refusal visible without stopping or replaying work", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.dispatch", "environments.list"],
      operatorScopes: ["operator.read", "operator.write"],
      sessionKey,
      methodResponses: {
        "sessions.list": chatSessionListResponse([localSession()]),
        "environments.list": catalog,
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const menu = await openMenu(page, "sidebar");
      await menu.getByText("Move to cloud…", { exact: true }).click();
      expect(await page.locator('[data-value="cloud:cloud"]').count()).toBe(0);
      await page.locator('[data-value="device:runner"]').click();
      await gateway.deferNext("sessions.dispatch");
      await page.getByRole("button", { name: "Continue on worker", exact: true }).click();
      await gateway.waitForRequest("sessions.dispatch");
      await gateway.rejectDeferred("sessions.dispatch", {
        code: "UNAVAILABLE",
        message: "Session is busy; wait for the active turn to finish.",
      });
      await page
        .getByText("Session is busy; wait for the active turn to finish.", { exact: false })
        .waitFor();
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
  it.each(["read-only", "busy", "reconnect"] as const)(
    "guards the right-click action while %s",
    async (scenario) => {
      const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const row = { ...localSession(), hasActiveRun: scenario === "busy" };
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.startup", "sessions.dispatch", "environments.list"],
        operatorScopes:
          scenario === "read-only" ? ["operator.read"] : ["operator.read", "operator.write"],
        sessionKey,
        methodResponses: {
          "sessions.list": chatSessionListResponse([row]),
          "environments.list": catalog,
        },
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const menu = await openMenu(page, "sidebar");
        const item = menu.getByRole("menuitem", { name: "Move to cloud…", exact: true });
        await item.waitFor();
        if (scenario !== "reconnect") {
          expect(await item.isDisabled()).toBe(true);
        } else {
          await item.click();
          await page.locator('[data-value="device:runner"]').click();
          await gateway.closeLatest(1001, "mock reconnect");
          await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(1);
          await page.getByRole("button", { name: "Continue on worker", exact: true }).click();
          await page
            .locator("openclaw-toast-host")
            .getByText("This Gateway does not support this session action.", { exact: false })
            .waitFor();
        }
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
  it("retries the same durable cloud move after a failed retry and reload", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const target = {
      kind: "profile" as const,
      profileId: "cloud",
      os: "windows/wsl2",
      machineClass: "fast",
    };
    const retry = {
      expected: { generation: 4, environmentId: "worker:notes", ownerEpoch: 7 },
      target,
    };
    const session = {
      ...remoteSession(),
      placement: { ...remoteSession().placement, state: "draining", generation: 5 },
      placementMove: { target, updatedAtMs: 5, error: "Workspace reconciliation failed.", retry },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.move"],
      operatorScopes: ["operator.admin", "operator.read", "operator.write"],
      sessionKey,
      historyMessages: [{ role: "assistant", content: "The release notes are ready for review." }],
      methodResponses: { "sessions.list": chatSessionListResponse([session]) },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.deferNext("sessions.move");
      await (await openMenu(page, "sidebar")).getByText("Retry move", { exact: true }).click();
      const first = await gateway.waitForRequest("sessions.move");
      expect(first.params).toEqual({ key: sessionKey, agentId: "main", ...retry });
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
      await gateway.rejectDeferred("sessions.move", {
        code: "UNAVAILABLE",
        message: "Workspace still cannot be reconciled.",
      });
      await page
        .locator("openclaw-toast-host")
        .getByText("Workspace still cannot be reconciled.", { exact: false })
        .waitFor();
      await page.reload();
      await page.getByRole("button", { name: "Move failed", exact: true }).click();
      await gateway.deferNext("sessions.move");
      const retryAction = page.locator(".chat-pane__placement-move");
      expect(await retryAction.textContent()).toContain("Retry move");
      expect(await retryAction.isDisabled()).toBe(false);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const proof = createControlUiE2eArtifactDir("session-placement-retry");
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [retryAction, page.getByText("Workspace reconciliation failed.", { exact: true })],
          { animations: "disabled" },
        );
        await writeFile(path.join(proof, "after-durable-retry.png"), frame.png);
      }
      await retryAction.click();
      const second = await gateway.waitForRequest("sessions.move");
      expect(second.params).toEqual({ key: sessionKey, agentId: "main", ...retry });
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.move", { ok: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("reconfirms the saved offline-device abandonment without changing its source", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const target = { kind: "gateway" as const };
    const retry = {
      expected: { generation: 4, environmentId: "worker:notes", ownerEpoch: 7 },
      target,
      abandonSource: true,
    };
    const session = {
      ...remoteSession(),
      placement: { ...remoteSession().placement, state: "draining", generation: 5 },
      placementMove: { target, updatedAtMs: 5, error: "Device teardown could not finish.", retry },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.move"],
      operatorScopes: ["operator.read", "operator.write"],
      sessionKey,
      methodResponses: { "sessions.list": chatSessionListResponse([session]) },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await (await openMenu(page, "header")).getByText("Retry move", { exact: true }).click();
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog
        .getByText("Unsynced device files and in-flight work may be lost.", { exact: false })
        .waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests("sessions.move")).toHaveLength(0);
      await (await openMenu(page, "header")).getByText("Retry move", { exact: true }).click();
      await gateway.deferNext("sessions.move");
      await dialog.getByRole("button", { name: "Continue on Gateway", exact: true }).click();
      expect((await gateway.waitForRequest("sessions.move")).params).toEqual({
        key: sessionKey,
        agentId: "main",
        ...retry,
      });
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.move", { ok: true });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
  it("offers only required profile defaults for an ordinary Move", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const required = {
      id: "cloud",
      providerId: "crabbox",
      machines: [{ id: "fast", label: "Fast" }],
      operatingSystems: [
        { id: "linux", label: "Linux" },
        { id: "windows", label: "Windows" },
      ],
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.move", "environments.list"],
      operatorScopes: ["operator.admin", "operator.read", "operator.write"],
      sessionKey,
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }],
          sessionPlacement: { requiredProfile: required },
        },
        "sessions.list": chatSessionListResponse([remoteSession()]),
        "environments.list": {
          ...catalog,
          profiles: [required, { id: "other", providerId: "crabbox" }],
        },
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await expect
        .poll(() =>
          evaluateControlUiContext(
            page,
            (app) => app.agents.state.agentsList?.sessionPlacement?.requiredProfile?.id,
          ),
        )
        .toBe("cloud");
      await (await openMenu(page, "header")).getByText("Move session…", { exact: true }).click();
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog.locator('[data-value="cloud:cloud"]').click();
      expect(await dialog.locator('[data-value="gateway"]').isDisabled()).toBe(true);
      expect(await dialog.locator('[data-value="gateway"]').getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(await dialog.locator('[data-value="device:runner"]').isDisabled()).toBe(true);
      expect(await dialog.locator('[data-value="cloud:other"]').isDisabled()).toBe(true);
      expect(await dialog.locator('[data-value^="machine:"], [data-value^="os:"]').count()).toBe(0);
      await gateway.deferNext("sessions.move");
      await dialog.getByRole("button", { name: "Move session", exact: true }).click();
      expect((await gateway.waitForRequest("sessions.move")).params).toEqual({
        key: sessionKey,
        agentId: "main",
        expected: { generation: 4, environmentId: "worker:notes", ownerEpoch: 7 },
        target: { kind: "profile", profileId: "cloud" },
      });
      await gateway.resolveDeferred("sessions.move", { ok: true });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
