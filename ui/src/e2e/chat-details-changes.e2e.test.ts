import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Details change summary",
  trackBrowserContexts: true,
});

suite.define(() => {
  it("observes only metadata while Details is presented and retains last-known changes on refresh failure", async () => {
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
      historyMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Make workspace navigation easier to scan and keep the layout compact.",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The navigation update is ready. I simplified the file list, refined keyboard focus, and verified the compact layout.",
            },
          ],
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
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Improve workspace navigation", { exact: true }).first().waitFor();
    await pauseVirtualClock(page);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(0);
    const details = await openChatDetails(page);
    const action = details.getByRole("button", { name: "All changes", exact: true });
    // The lazy Session view must mount before its summary timer can advance.
    await action.waitFor();
    await page.clock.runFor(1);
    await expect.poll(() => action.textContent()).toContain("12 files");
    expect(await action.textContent()).toContain("+248");
    expect(await action.textContent()).toContain("−61");
    expect(await details.locator(".chat-details__participants").count()).toBe(0);
    expect((await gateway.getRequests("sessions.diff"))[0]?.params).toMatchObject({
      scope: "all",
      summaryOnly: true,
    });
    const dir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("details-changes-after")
        : undefined;
    async function capture(name: string) {
      if (!dir) {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(page, details, [action], {
        animations: "disabled",
        elements: [details],
      });
      await fs.writeFile(path.join(dir, name + ".png"), frame.png);
      await fs.writeFile(path.join(dir, name + "-details.png"), frame.elements[0]!.png);
    }
    await capture("after-dark");
    if (dir) {
      await page.emulateMedia({ colorScheme: "light" });
      await page.clock.runFor(32);
      await capture("after-light");
      await page.emulateMedia({ colorScheme: "dark" });
    }
    await gateway.deferNext("sessions.diff", { summaryOnly: true });
    await page.clock.runFor(30_001);
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(2);
    expect(await action.textContent()).toContain("+248");
    await page.clock.runFor(1_000);
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(2);
    await gateway.rejectDeferred("sessions.diff", {
      code: "UNAVAILABLE",
      message: "Temporary checkout read failure",
    });
    await expect.poll(() => action.textContent()).toContain("stale");
    expect(await action.textContent()).toContain("12 files");
    expect(await action.getAttribute("aria-description")).toContain("Last-known changes");
    await capture("after-stale-dark");
    await gateway.setMethodResponse("sessions.diff", {
      sessionKey: "main",
      files: [{ path: "src/app.ts", status: "modified", additions: 12480, deletions: 1030 }],
      additions: 12480,
      deletions: 1030,
      truncated: true,
    });
    await page.clock.runFor(30_001);
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(3);
    await expect.poll(() => action.textContent()).toContain("+12.5K");
    expect(await action.textContent()).toContain("partial");
    expect(await action.textContent()).not.toContain("stale");
    expect(await action.getAttribute("aria-description")).toContain("+12480 lines, −1030 lines");
    if (dir) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.clock.runFor(32);
      await capture("after-large-narrow-dark");
      await page.setViewportSize({ width: 1180, height: 800 });
      await page.clock.runFor(32);
    }
    await closeChatDetails(page);
    const beforeHidden = (await gateway.getRequests("sessions.diff")).length;
    await page.clock.fastForward(60_000);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(beforeHidden);
    await openChatDetails(page);
    await page.clock.runFor(1);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).length)
      .toBe(beforeHidden + 1);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    await action.click();
    await expect
      .poll(
        async () =>
          (await gateway.getRequests("sessions.diff")).length -
          (await gateway.getRequests("sessions.diff", { summaryOnly: true })).length,
      )
      .toBe(1);
    expect((await gateway.getRequests("sessions.diff")).at(-1)?.params).toMatchObject({
      scope: "all",
    });
  });
});
