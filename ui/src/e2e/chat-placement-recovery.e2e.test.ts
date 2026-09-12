import path from "node:path";
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

suite.define(() => {
  it("recovers a failed cloud session locally and clears its previous failure during restart", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const proofDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("cloud-local-recovery")
        : null;
    const session = {
      key: "agent:main:cloud-recovery",
      label: "Recover cloud session",
      kind: "direct",
      updatedAt: Date.now(),
      placement: {
        state: "failed",
        generation: 2,
        createdAtMs: 1,
        updatedAtMs: 2,
        stateChangedAtMs: 2,
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
      const error = page.getByText(`Runner failed: ${session.placement.recoveryError}`, {
        exact: true,
      });
      await error.waitFor();
      await page.getByRole("button", { name: "Restart session…", exact: true }).click();
      const local = page.locator('[data-value="gateway"]');
      await local.waitFor();
      await local.click();
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "local-recovery-picker.png") });
      }
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
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "restarting-error-cleared.png") });
      }

      const recovered = {
        ...session,
        placement: {
          state: "local",
          generation: 3,
          createdAtMs: 1,
          updatedAtMs: 3,
          stateChangedAtMs: 3,
        },
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
      expect(new URL(page.url()).pathname).toBe(
        new URL(controlUiSessionUrl(suite.server.baseUrl, session.key)).pathname,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
