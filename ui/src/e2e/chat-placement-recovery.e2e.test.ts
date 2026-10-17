import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const placement = <State extends "failed" | "local" | "active">(state: State, generation = 2) => ({
  state,
  generation,
  createdAtMs: 1,
  updatedAtMs: generation,
  stateChangedAtMs: generation,
});
function recoverySession(id: string, label: string) {
  return {
    key: `agent:main:${id}`,
    sessionId: `${id}-session`,
    label,
    kind: "direct" as const,
    updatedAt: Date.now(),
  };
}
function proof(page: Page, name: string) {
  const dir =
    process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" ? createControlUiE2eArtifactDir(name) : null;
  return async (filename: string) => {
    if (dir) {
      await page.screenshot({ path: path.join(dir, filename + ".png") });
    }
  };
}
async function openFailure(page: Page, message: string) {
  const failure = page.locator(".chat-error").filter({ hasText: message });
  await failure
    .locator("summary strong")
    .getByText("Couldn't finish this reply. Check the conversation before trying again.")
    .waitFor();
  await failure.locator("summary").click();
  const details = failure.getByLabel("Error details", { exact: true });
  await details.waitFor();
  expect(await details.textContent()).toBe(`Runner failed: ${message}`);
  return failure;
}
function expectSameSession(page: Page, key: string) {
  expect(new URL(page.url()).pathname).toBe(
    new URL(controlUiSessionUrl(suite.server.baseUrl, key)).pathname,
  );
}

suite.define(() => {
  it("sends the next message from a recoverable failed worker without restarting the conversation", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const capture = proof(page, "failed-worker-send-recovery");
    const session = {
      ...recoverySession("worker-continuation", "Continue after worker recovery"),
      placement: {
        ...placement("failed"),
        environmentId: "worker-previous",
        recoveryAction: "restart",
        retryOnSend: true,
        recoveryError: "The previous worker stopped after the Gateway restarted.",
      },
    } satisfies GatewaySessionRow;
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.send", "sessions.reclaim", "sessions.dispatch"],
      historyMessages: [{ role: "assistant", content: "The last reply is still here." }],
      sessionKey: session.key,
      sessionInfo: session,
      methodResponses: { "sessions.list": chatSessionListResponse([session]) },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      await openFailure(page, session.placement.recoveryError);
      const composer = page.getByRole("textbox", { name: "Chat composer" });
      await capture("failed-worker-composer");
      expect(await composer.isEnabled()).toBe(true);
      expect(
        await page.getByText("Restart this session to continue.", { exact: true }).count(),
      ).toBe(0);

      await composer.fill("Continue with the next step");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        sessionKey: session.key,
        message: "Continue with the next step",
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expectSameSession(page, session.key);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("recovers a failed cloud session locally and clears its previous failure during restart", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const capture = proof(page, "cloud-local-recovery");
    const session = {
      ...recoverySession("cloud-recovery", "Recover cloud session"),
      placement: {
        ...placement("failed"),
        recoveryAction: "restart",
        recoveryError: "Cloud worker disappeared: worker provider no longer recognizes the lease.",
      },
    } satisfies GatewaySessionRow;
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.reclaim", "sessions.dispatch"],
      historyMessages: [
        { role: "assistant", content: "The last saved workspace is ready for recovery." },
      ],
      sessionKey: session.key,
      sessionInfo: session,
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
        "environments.list": { profiles: [{ id: "aws", providerId: "crabbox" }], environments: [] },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const error = await openFailure(page, session.placement.recoveryError);
      await page.getByRole("button", { name: "Restart session…", exact: true }).click();
      const local = page.locator('[data-value="gateway"]');
      await local.waitFor();
      await local.click();
      await capture("local-recovery-picker");
      await gateway.deferNext("sessions.reclaim");
      await page.getByRole("button", { name: "Restart session", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.reclaim");
      expect(request.params).toEqual({
        key: session.key,
        agentId: "main",
        recoverToGateway: { expectedGeneration: 2 },
      });
      await page.getByText("Restarting session…", { exact: true }).first().waitFor();
      await expect.poll(() => error.count()).toBe(0);
      await capture("restarting-error-cleared");

      const recovered = {
        ...session,
        placement: placement("local", 3),
      } satisfies GatewaySessionRow;
      await gateway.setSessionsListResponse(chatSessionListResponse([recovered]));
      await gateway.resolveDeferred("sessions.reclaim", {
        ok: true,
        placement: recovered.placement,
      });
      await expect
        .poll(() => page.getByRole("textbox", { name: "Chat composer" }).isEnabled())
        .toBe(true);
      await expect.poll(() => error.count()).toBe(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expectSameSession(page, session.key);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("dispatches a local repository-only session before accepting another turn", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const capture = proof(page, "repository-placement-recovery");
    const session = {
      ...recoverySession("repository-recovery", "Recover repository session"),
      repositoryWorkspaceId: "repository-workspace-1",
      placement: placement("local"),
      agentRuntime: {
        id: "openclaw",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "worker-turn",
        devicePlacementSupported: true,
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
        source: "model",
      },
    } satisfies GatewaySessionRow;
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.send", "sessions.dispatch"],
      historyMessages: [
        { role: "assistant", content: "The repository is ready on another worker." },
      ],
      sessionKey: session.key,
      sessionInfo: session,
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
        "environments.list": {
          profiles: [{ id: "aws", providerId: "crabbox" }],
          environments: [
            {
              id: "node:runner",
              type: "node",
              label: "Repository runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const composer = page.getByRole("textbox", { name: "Chat composer" });
      await page.getByText("Repository worker required", { exact: true }).waitFor();
      expect(await composer.isEnabled()).toBe(false);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await capture("worker-required");

      await page
        .locator(".agent-chat__disabled-banner")
        .getByRole("button", { name: "Choose worker…", exact: true })
        .click();
      await page.locator('[data-value="device:runner"]').click();
      expect(await page.locator('[data-value="gateway"]').count()).toBe(0);
      await capture("worker-picker");
      await gateway.deferNext("sessions.dispatch");
      await page.getByRole("button", { name: "Continue on worker", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.dispatch");
      expect(request.params).toEqual({
        key: session.key,
        agentId: "main",
        deviceId: "runner",
      });
      await page.getByText("Starting worker…", { exact: true }).first().waitFor();

      const recovered = {
        ...session,
        placement: {
          ...placement("active", 3),
          environmentId: "node:runner",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "base-manifest",
          remoteWorkspaceDir: "/worker/repository",
          runner: { kind: "device", status: "available", deviceId: "runner" },
        },
      } satisfies GatewaySessionRow;
      await gateway.setSessionsListResponse(chatSessionListResponse([recovered]));
      await gateway.resolveDeferred("sessions.dispatch", {
        ok: true,
        placement: recovered.placement,
      });
      await expect.poll(() => composer.isEnabled()).toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await composer.fill("Continue after repository recovery");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const send = await gateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({
        sessionKey: session.key,
        message: "Continue after repository recovery",
      });
      await capture("follow-up-accepted");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
