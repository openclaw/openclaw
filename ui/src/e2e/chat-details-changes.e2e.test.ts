import { expect, it } from "vitest";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details Environment changes" });

suite.define(() => {
  it("shares read-only Uncommitted demand between Environment and Review and recovers retained counts", async () => {
    await suite.withPage({ viewport: { width: 1180, height: 800 } }, async ({ page }) => {
      await page.clock.install();
      const result = (additions: number, deletions: number) => ({
        sessionKey: "main",
        branch: "feature/workspace-navigation",
        baseRef: "HEAD",
        files: [{ path: "src/app.ts", status: "modified", additions, deletions }],
        additions,
        deletions,
      });
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        operatorScopes: ["operator.read"],
        workspace: "/workspace/openclaw",
        workspaceGit: true,
        sessions: [
          createControlUiSessionRow("agent:main:main", "Workspace", 1, {
            repository: {
              url: "https://github.com/example/workspace",
              branch: "feature/workspace-navigation",
            },
          }),
        ],
        methodResponses: { "sessions.diff": result(248, 61) },
      });
      const reads = () => gateway.getRequests("sessions.diff");
      const readCount = () => expect.poll(async () => (await reads()).length);
      await page.goto(suite.server.baseUrl + "chat");
      await page
        .getByText("Workspace", { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      expect(await reads()).toHaveLength(0);
      const details = await openChatDetails(page);
      const action = details.locator('[data-details-group="environment"] .chat-pr__diff');
      await readCount().toBe(1);
      await expect.poll(() => action.textContent()).toContain("+248");
      expect(await action.textContent()).toContain("−61");
      expect((await reads())[0]?.params).toMatchObject({ scope: "uncommitted" });
      expect(await page.locator(".session-diff").count()).toBe(0);

      await closeChatDetails(page);
      await pauseVirtualClock(page);
      await page.clock.fastForward(60_000);
      await gateway.deferNext("sessions.diff", { scope: "uncommitted" });
      await page.clock.resume();
      await openChatDetails(page);
      await readCount().toBe(2);
      await gateway.rejectDeferred("sessions.diff", {
        code: "UNAVAILABLE",
        message: "Checkout unavailable",
      });
      expect(await action.textContent()).toContain("+248");
      expect(await action.textContent()).toContain("−61");

      await closeChatDetails(page);
      await pauseVirtualClock(page);
      await page.clock.fastForward(60_000);
      await gateway.setMethodResponse("sessions.diff", { ...result(12480, 1030), truncated: true });
      await gateway.deferNext("sessions.diff", { scope: "uncommitted" });
      await page.clock.resume();
      await openChatDetails(page);
      await readCount().toBe(3);
      // Review must join the Environment read, not issue a competing request.
      await action.click();
      const review = page.locator(".session-diff");
      await expect.poll(() => review.getAttribute("aria-busy")).toBe("true");
      expect(await reads()).toHaveLength(3);
      await gateway.resolveDeferred("sessions.diff");
      await expect.poll(() => review.getAttribute("aria-busy")).toBe("false");
      await expect.poll(() => action.textContent()).toContain("+12,480");
      expect(await action.textContent()).toContain("−1,030");
      expect(
        await action.getByLabel("Some changes could not be displayed.", { exact: true }).count(),
      ).toBe(0);
      expect(
        await review
          .getByRole("button", { name: "Choose change scope", exact: true })
          .textContent(),
      ).toBe("Uncommitted");
      expect(await review.locator(".session-diff__filename").allTextContents()).toEqual(["app.ts"]);
      expect(await reads()).toHaveLength(3);
      for (const params of [{ scope: "all" }, { summaryOnly: true }]) {
        expect(await gateway.getRequests("sessions.diff", params)).toHaveLength(0);
      }
      for (const method of [
        "sessions.files.list",
        "sessions.files.get",
        "sessions.files.set",
        "sessions.patch",
        "chat.send",
      ]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });
});
