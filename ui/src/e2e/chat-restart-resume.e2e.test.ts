import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each(["in-place", "new-session"])("resumes an interrupted task (%s)", async (mode) => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:restart-resume";
        const sessionId = "restart-resume-session";
        const session = {
          key: sessionKey,
          sessionId,
          kind: "direct",
          label: "Continue the release checklist",
          status: "done",
          restartRecoveryStatus: "tombstoned",
          restartRecoveryCycleId: "restart-cycle-1",
          updatedAt: 1_000,
        };
        const history = {
          messages: [
            { role: "user", content: "Verify the release checklist and report the result." },
            { role: "assistant", content: "The build passed. I will check the package next." },
          ],
          sessionId,
          sessionInfo: session,
        };
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.recover"],
          deferredMethods: ["sessions.recover"],
          sessionKey,
          sessionInfo: session,
          sessions: [session],
          methodResponses: {
            "chat.startup": history,
            "chat.history": history,
            "sessions.list": chatSessionListResponse([session]),
            "sessions.recover": {
              ok: true,
              key: sessionKey,
              sessionId,
              continuation: { status: "started", runId: "resumed-task" },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("chat.startup");
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const banner = pane.locator(".agent-chat__disabled-banner");
        const resume = banner.getByRole("button", { name: "Resume", exact: true });
        await resume.waitFor();
        expect(await resume.isEnabled()).toBe(true);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, pane, [banner, resume], {
            animations: "disabled",
            elements: [banner],
          });
          await writeFile(path.join(suite.artifactDir, "restart-resume-after.png"), frame.png);
        }

        await resume.click();
        const request = await gateway.waitForRequest("sessions.recover");
        expect(request.params).toEqual({
          agentId: "main",
          key: sessionKey,
          mode: "in-place",
          sessionId,
          recoveryCycleId: "restart-cycle-1",
        });
        await banner.getByRole("button", { name: "Resuming…", exact: true }).waitFor();
        if (mode === "new-session") {
          await gateway.resolveDeferred("sessions.recover", {
            ok: true,
            key: sessionKey,
            sessionId,
            continuation: {
              status: "rejected",
              error: {
                code: "UNAVAILABLE",
                message: "This provider cannot safely resume tool work in place.",
                details: { reason: "restart-safe-tools-unavailable" },
              },
            },
          });
          const fallback = banner.getByRole("button", {
            name: "Resume in new session",
            exact: true,
          });
          await fallback.waitFor();
          expect(page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          expect(await gateway.getRequests("sessions.recover")).toHaveLength(1);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(page, pane, [banner, fallback], {
              animations: "disabled",
              elements: [banner],
            });
            await writeFile(path.join(suite.artifactDir, "restart-resume-fallback.png"), frame.png);
          }
        }
        const resumedKey = mode === "new-session" ? "agent:main:dashboard:replacement" : sessionKey;
        const resumedSession = {
          ...session,
          key: resumedKey,
          sessionId: mode === "new-session" ? "replacement-session" : sessionId,
          restartRecoveryStatus: undefined,
          restartRecoveryCycleId: undefined,
        };
        const resumedHistory = {
          ...history,
          sessionId: resumedSession.sessionId,
          sessionInfo: resumedSession,
        };
        await gateway.setMethodResponse("sessions.list", chatSessionListResponse([resumedSession]));
        await gateway.setMethodResponse("chat.history", resumedHistory);
        await gateway.setMethodResponse("chat.startup", resumedHistory);
        await gateway.setMethodResponse("sessions.recover", {
          ok: true,
          key: resumedKey,
          sessionId: resumedSession.sessionId,
          continuation: { status: "started", runId: "resumed-task" },
        });
        if (mode === "new-session") {
          await banner.getByRole("button", { name: "Resume in new session", exact: true }).click();
          const fallbackRequest = await gateway.waitForRequest("sessions.recover", { after: 1 });
          expect(fallbackRequest.params).toEqual({
            agentId: "main",
            key: sessionKey,
            sessionId,
            recoveryCycleId: "restart-cycle-1",
            mode: "new-session",
          });
        } else {
          await gateway.resolveDeferred("sessions.recover");
        }
        await expect
          .poll(() => page.url())
          .toBe(controlUiSessionUrl(suite.server.baseUrl, resumedKey));
        await pane.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect(await banner.count()).toBe(0);
        await pane
          .getByText("The build passed. I will check the package next.", { exact: true })
          .waitFor();
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.recover")).toHaveLength(
          mode === "new-session" ? 2 : 1,
        );
      },
    );
  });
});
