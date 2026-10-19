import { expect, it } from "vitest";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Details Environment changes",
  trackBrowserContexts: true,
});

suite.define(() => {
  it("shares read-only Uncommitted demand between Environment and Review and recovers retained counts", async () => {
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1180, height: 800 },
    });
    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      operatorScopes: ["operator.read"],
      workspace: "/workspace/openclaw",
      workspaceGit: true,
      models: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
      agentModel: "openai/gpt-4.1",
      sessions: [
        {
          key: "agent:main:main",
          sessionId: "details-summary-session",
          kind: "direct",
          label: "Improve workspace navigation",
          participantCount: 0,
          model: "gpt-4.1",
          modelProvider: "openai",
          createdActor: { type: "human", id: "ada", label: "Ada" },
          repository: {
            url: "https://github.com/example/workspace",
            branch: "feature/workspace-navigation",
          },
        },
      ],
      methodResponses: {
        "cron.list": {
          jobs: [],
          total: 0,
          offset: 0,
          limit: 20,
          hasMore: false,
          nextOffset: null,
          snapshotRevision: "1",
        },
        "sessions.diff": {
          sessionKey: "main",
          branch: "feature/workspace-navigation",
          baseRef: "main",
          files: Array.from({ length: 12 }, (_, index) => ({
            path: `src/view-${index}.ts`,
            status: "modified",
            additions: 20,
            deletions: 5,
          })),
          additions: 248,
          deletions: 61,
        },
      },
    });
    await page.goto(suite.server.baseUrl + "chat");
    await page
      .getByText("Improve workspace navigation", { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor();
    await pauseVirtualClock(page);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(0);
    const details = await openChatDetails(page);
    const environment = details.locator('[data-details-group="environment"]');
    const disclosure = environment.locator(":scope > summary");
    const action = environment.getByRole("button", { name: /^Changes/ });
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(1);
    await page.clock.runFor(1);
    await expect.poll(() => action.textContent()).toContain("+248");
    expect(await action.textContent()).toContain("−61");
    expect((await gateway.getRequests("sessions.diff"))[0]?.params).toMatchObject({
      scope: "uncommitted",
    });
    expect(await gateway.getRequests("sessions.diff", { summaryOnly: true })).toHaveLength(0);
    expect(await page.locator(".session-diff").count()).toBe(0);
    await disclosure.press("Enter");
    await expect.poll(() => disclosure.getAttribute("aria-expanded")).toBe("false");
    await page.clock.fastForward(60_000);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(1);
    await gateway.deferNext("sessions.diff", { scope: "uncommitted" });
    await disclosure.press("Enter");
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(2);
    expect(await action.textContent()).toContain("+248");
    await page.clock.fastForward(60_000);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(2);
    await gateway.rejectDeferred("sessions.diff", {
      code: "UNAVAILABLE",
      message: "Temporary checkout read failure",
    });
    expect(await action.textContent()).toContain("+248");
    expect(await action.textContent()).toContain("−61");

    await closeChatDetails(page);
    await page.clock.fastForward(60_000);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(2);
    await gateway.setMethodResponse("sessions.diff", {
      sessionKey: "main",
      branch: "feature/workspace-navigation",
      baseRef: "HEAD",
      files: [{ path: "src/app.ts", status: "modified", additions: 12480, deletions: 1030 }],
      additions: 12480,
      deletions: 1030,
      truncated: true,
    });
    await gateway.deferNext("sessions.diff", { scope: "uncommitted" });
    await openChatDetails(page);
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(3);
    expect(await action.textContent()).toContain("+248");

    // Review joins Environment's pending read through the checkout owner.
    await action.click();
    const review = page.locator(".session-diff");
    await expect.poll(() => review.getAttribute("aria-busy")).toBe("true");
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(3);
    await gateway.resolveDeferred("sessions.diff");
    await expect.poll(() => review.getAttribute("aria-busy")).toBe("false");
    await expect.poll(() => action.textContent()).toContain("+12480");
    expect(await action.textContent()).toContain("−1030");
    expect(
      await action.getByLabel("Some changes could not be displayed.", { exact: true }).count(),
    ).toBe(1);
    expect(await review.locator(".session-diff__section-title span").textContent()).toBe(
      "Uncommitted",
    );
    expect(await review.locator(".session-diff__filename").allTextContents()).toEqual(["app.ts"]);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(3);
    expect(await gateway.getRequests("sessions.diff", { scope: "all" })).toHaveLength(0);
    expect(await gateway.getRequests("sessions.diff", { summaryOnly: true })).toHaveLength(0);
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
