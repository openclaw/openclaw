import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import type { ControlUiSessionFixture } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

type RuntimeSessionFixture = GatewaySessionRow & ControlUiSessionFixture;

const suite = createSessionManagementE2eSuite(true);
suite.define(() => {
  it("updates a retained card on child lifecycle events, including after reload", async () => {
    const artifactDir = createControlUiE2eArtifactDir("progress-card-runtime");
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1100, height: 850 } },
      async ({ page }) => {
        const now = Date.now();
        const parent: RuntimeSessionFixture = {
          key: "agent:main:progress-runtime",
          sessionId: "session:agent:main:progress-runtime",
          kind: "direct",
          label: "Prepare the report",
          status: "done",
          hasActiveRun: false,
          hasActiveSubagentRun: true,
          startedAt: now - 180_000,
          endedAt: now - 60_000,
          updatedAt: now,
        };
        const children: RuntimeSessionFixture[] = Array.from({ length: 5 }, (_, index) => ({
          key: `agent:main:subagent:progress-${index}`,
          sessionId: `session:agent:main:subagent:progress-${index}`,
          kind: "direct",
          classification: "subagent",
          label: `Report section ${index + 1}`,
          spawnedBy: parent.key,
          parentSessionKey: parent.key,
          status: index < 2 ? "running" : "queued",
          hasActiveRun: index < 2,
          startedAt: now - 70_000,
          updatedAt: now,
        }));
        parent.childSessions = children.map((child) => child.key);
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [parent, ...children],
          historyMessages: [
            {
              role: "assistant",
              content: "The report sections are delegated. I will collect and review the results.",
            },
          ],
          methodResponses: {
            "progressCard.get": {
              card: {
                sessionKey: parent.key,
                revision: 1,
                updatedAt: now - 90_000,
                markdown: "The report has five sections. Results will be reviewed before delivery.",
                steps: [
                  { step: "Confirm the report scope", status: "completed" },
                  { step: "Prepare the five sections", status: "in_progress" },
                  { step: "Review and deliver the report", status: "pending" },
                ],
              },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const card = await openChatTaskProgress(page);

        const capture = async (name: string) => {
          const frame = await takeControlUiScreenshotFrame(page, card, [card.locator("summary")], {
            elements: [card],
            animations: "disabled",
            viewport: { width: 1100, height: 850 },
          });
          await writeFile(path.join(artifactDir, `${name}.png`), frame.png);
          await writeFile(path.join(artifactDir, `${name}-card.png`), frame.elements[0]!.png);
        };

        await capture("00-initial");
        await expect
          .poll(async () =>
            (await card.locator(".session-progress-card__runtime").allTextContents()).join(" "),
          )
          .toContain("2 running · 3 queued");
        await capture("01-delegated");
        expect(await card.locator(".session-progress-card__step--completed").count()).toBe(1);
        expect(await card.locator('[data-outcome="done"]').count()).toBe(0);

        const failedAt = Date.now() + 1;
        children[0] = {
          ...children[0]!,
          status: "failed",
          hasActiveRun: false,
          endedAt: failedAt,
          updatedAt: failedAt,
          snapshotAt: failedAt,
          lastRunError: "Report source unavailable",
        };
        await gateway.setSessionsListResponse(sessionsListResponse([parent, ...children]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: children[0].key,
          reason: "run-end",
          ts: failedAt,
          session: children[0],
          ancestorSessions: [parent],
        });
        await expect
          .poll(() => card.locator(".session-progress-card__runtime").textContent())
          .toContain("1 running · 3 queued · 1 failed");
        await capture("02-child-failed");
        await card.locator("summary").click();
        await capture("03-collapsed");
        await page.reload();
        await openChatTaskProgress(page);
        await expect
          .poll(() => card.locator(".session-progress-card__runtime").textContent())
          .toContain("1 running · 3 queued · 1 failed");
        await page.setViewportSize({ width: 390, height: 844 });
        const mobile = await openChatTaskProgress(page);
        await expect
          .poll(() => mobile.locator(".session-progress-card__runtime").textContent())
          .toContain("1 running · 3 queued · 1 failed");
        const mobileFrame = await takeControlUiScreenshotFrame(
          page,
          mobile,
          [mobile.locator(".session-progress-card__runtime")],
          { elements: [mobile], animations: "disabled" },
        );
        await writeFile(path.join(artifactDir, "04-mobile.png"), mobileFrame.png);
        expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
