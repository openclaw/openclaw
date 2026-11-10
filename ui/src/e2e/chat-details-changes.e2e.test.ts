import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import {
  publicationMethods,
  publicationOptions,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details Environment changes" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("explains host workspace restrictions without requesting a forbidden diff", async () => {
    await suite.withPage({ viewport: { width: 1180, height: 800 } }, async ({ page }) => {
      const reason =
        "Your operator role requires a sandboxed session. Ask the owner to share the files in your own session.";
      const gateway = await installMockGateway(page, {
        featureMethods: [...publicationMethods, "sessions.diff"],
        operatorScopes: ["operator.read", "operator.write"],
        workspace: "/workspace/project",
        workspaceGit: true,
        sessions: [
          createControlUiSessionRow("agent:main:main", "Shared host session", 1, {
            workspaceReadDisabledReason: reason,
          }),
        ],
        methodResponses: {
          "sessions.diff": { __mockError: { code: "FORBIDDEN", message: reason } },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await openChatDetails(page);
      await openChatSidePanelType(page, "Review");
      const panel = page.locator('[data-panel-slot="detail"]:not([hidden])');
      if (captureUiProof) {
        const frame = await takeControlUiScreenshotFrame(page, panel, [panel], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "restricted-workspace.png"), frame.png);
      }
      expect(await gateway.getRequests("sessions.diff")).toHaveLength(0);
      await panel.getByText(reason, { exact: true }).waitFor();
      expect(await panel.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
    });
  });

  it.each(["published", "failed"] as const)(
    "shows local changes beside an existing PR after a %s publication",
    async (status) => {
      await suite.withPage(
        {
          viewport: { width: 1180, height: 800 },
          ...(captureUiProof ? { recordVideo: { dir: suite.artifactDir } } : {}),
        },
        async ({ page }) => {
          const branch = "feature/workspace-navigation";
          const publication = {
            requestId: "existing-pr-publication",
            status,
            publisher: publicationOptions.shared,
            ...(status === "published"
              ? {
                  repository: "example/workspace",
                  branch,
                  url: "https://github.com/example/workspace/pull/42",
                  headCommit: "a".repeat(40),
                }
              : {
                  code: "unavailable",
                  message: "The earlier publication failed.",
                  nextAction: "Check the existing pull request.",
                }),
          };
          const gateway = await installMockGateway(page, {
            featureMethods: [...publicationMethods, "sessions.diff"],
            workspace: "/workspace/openclaw",
            workspaceGit: true,
            historyMessages: [
              {
                role: "user",
                content: "Refine workspace navigation and keep the pull request up to date.",
              },
              {
                role: "assistant",
                content:
                  "The navigation pull request is open. I am adjusting the keyboard behavior and adding the remaining focus checks.",
              },
            ],
            sessions: [
              createControlUiSessionRow("agent:main:main", "Refine workspace navigation", 1, {
                repository: { url: "https://github.com/example/workspace", branch },
              }),
            ],
            methodResponses: {
              "sessions.github.options": {
                ...publicationOptions,
                latestShared: { result: publication, confirmation: null },
              },
              "sessions.diff": {
                sessionKey: "main",
                branch,
                baseRef: "HEAD",
                files: [
                  { path: "src/navigation.ts", status: "modified", additions: 18, deletions: 4 },
                ],
                additions: 18,
                deletions: 4,
              },
            },
          });
          await page.goto(suite.server.baseUrl + "chat");
          const details = await openChatDetails(page);
          const key = await waitForWatchedSessionKey(gateway);
          await gateway.waitForRequest("sessions.github.options");
          await gateway.waitForRequest("sessions.diff");
          // The Gateway omits branch publication facts when this checkout already
          // has a live PR, including a PR whose base is the fork's parent.
          await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
            sessions: {
              [key]: {
                status: "ready",
                rateLimited: false,
                repository: { owner: "example", repo: "workspace" },
                pullRequests: [
                  {
                    owner: "example",
                    repo: "workspace",
                    branch,
                    number: 42,
                    title: "Refine workspace navigation",
                    url: "https://github.com/example/workspace/pull/42",
                    state: "open",
                  },
                ],
              },
            },
          });
          const environment = details.locator('[data-details-group="environment"]');
          const pr = details
            .locator('a[href="https://github.com/example/workspace/pull/42"]')
            .first();
          await pr.waitFor();
          const frame = await takeControlUiScreenshotFrame(page, details, [pr, environment], {
            elements: [details],
            animations: "disabled",
          });
          if (captureUiProof) {
            await writeFile(path.join(suite.artifactDir, status + ".png"), frame.png);
          }
          expect.soft(await environment.locator(".chat-pr__publication-actions").count()).toBe(0);
          const changes = environment.locator(".chat-pr__diff");
          await expect.poll(() => changes.textContent()).toContain("+18");
          expect(await changes.textContent()).toContain("−4");
          await changes.click();
          const review = page.locator(".session-diff");
          await expect.poll(() => review.textContent()).toContain("navigation.ts");
          expect(
            await review
              .getByRole("button", { name: "Choose change scope", exact: true })
              .textContent(),
          ).toBe("Uncommitted");
          expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
        },
      );
    },
  );

  it("loads read-only Environment totals separately from Review patches and recovers retained counts", async () => {
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
      expect((await reads())[0]?.params).toMatchObject({
        scope: "uncommitted",
        summaryOnly: true,
      });
      expect(await page.locator(".session-diff").count()).toBe(0);

      await closeChatDetails(page);
      await pauseVirtualClock(page);
      await page.clock.fastForward(60_000);
      await gateway.deferNext("sessions.diff", { scope: "uncommitted", summaryOnly: true });
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
      const recovered = { ...result(12480, 1030), truncated: true };
      await gateway.deferNext("sessions.diff", { scope: "uncommitted", summaryOnly: true });
      await page.clock.resume();
      await openChatDetails(page);
      await readCount().toBe(3);
      // Review needs patches, so a pending totals read cannot satisfy it.
      await gateway.deferNext("sessions.diff", { scope: "uncommitted" });
      await action.click();
      const review = page.locator(".session-diff");
      await readCount().toBe(4);
      expect((await reads())[3]?.params).not.toHaveProperty("summaryOnly");
      await expect.poll(() => review.getAttribute("aria-busy")).toBe("true");
      await gateway.resolveDeferred("sessions.diff", recovered, { match: { summaryOnly: true } });
      expect(await review.getAttribute("aria-busy")).toBe("true");
      expect(await action.textContent()).toContain("+248");
      await gateway.resolveDeferred("sessions.diff", {
        ...recovered,
        files: recovered.files.map((file) =>
          Object.assign({}, file, {
            patch: "@@ -1 +1 @@\n-old navigation\n+recovered navigation\n",
          }),
        ),
      });
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
      await review.locator(".session-diff__file-toggle").click();
      await expect
        .poll(() => review.locator(".chat-diff__row--add").textContent())
        .toContain("recovered navigation");
      expect(await reads()).toHaveLength(4);
      expect(await gateway.getRequests("sessions.diff", { summaryOnly: true })).toHaveLength(3);
      expect(await gateway.getRequests("sessions.diff", { scope: "all" })).toHaveLength(0);
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
