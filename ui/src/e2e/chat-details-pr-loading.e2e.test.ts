import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
} from "../../../src/gateway/control-ui-contract.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import {
  publicationMethods,
  publicationOptions,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";
import { nextPaint } from "./chat-session-diff.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Details module loading",
  startServerBeforeBrowser: true,
});
const options = {
  viewport: { width: 1540, height: 1000 },
  locale: "en-US",
  colorScheme: "dark" as const,
  serviceWorkers: "block" as const,
};
const sessionKey = "agent:main:main";
const scenario: ControlUiMockGatewayScenario = {
  communityInvite: false,
  agentModel: "gpt-4.1",
  sessions: [
    {
      key: sessionKey,
      kind: "direct",
      sessionId: "details-loading",
      label: "Details loading example",
      updatedAt: 1,
      worktree: { id: "example", branch: "feature/details", repoRoot: "/workspace/example" },
      createdActor: { type: "human", id: "demo-reader", label: "Demo reader" },
    },
  ],
  historyMessages: [chatMessage("assistant", "The review document and pull request are ready.")],
};
const repository = { owner: "synthetic", repo: "layout-demo" };
const pullRequest = (number: number) => ({
  ...repository,
  number,
  branch: "feature/details",
  state: "open",
  title: `Review item ${number}`,
  url: `https://github.com/synthetic/layout-demo/pull/${number}`,
});

async function capture(page: Page, details: Locator, content: Locator, stage: string) {
  if (!process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
    return;
  }
  const directory = createControlUiE2eArtifactDir(`details-${stage}`);
  const frame = await takeControlUiScreenshotFrame(page, details, [content], {
    animations: "disabled",
    elements: [details],
  });
  await writeFile(path.join(directory, "page.png"), frame.png);
  await writeFile(path.join(directory, "details.png"), frame.elements[0]!.png);
}

suite.define(() => {
  it.each([false, true])(
    "keeps PR loading geometry and sibling controls stable (recovered receipt=%s)",
    async (receipt) => {
      await suite.withPage(options, async ({ page }) => {
        const published = {
          requestId: "bdca439a-e787-4f9f-b5f3-a878c662cc77",
          publisher: publicationOptions.shared,
          status: "published",
          repository: "synthetic/layout-demo",
          branch: "feature/details",
          headCommit: "a".repeat(40),
          url: pullRequest(42).url,
        };
        const gateway = await installMockGateway(page, {
          ...scenario,
          featureMethods: publicationMethods,
          deferredMethods: ["sessions.github.options"],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "sessions.github.options": {
              ...publicationOptions,
              latestShared: receipt ? { result: published, confirmation: null } : null,
            },
          },
        });
        const module = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest(
            "ui/src/pages/chat/components/chat-pull-requests-content.tsx",
          ),
        );
        await page.goto(suite.server.baseUrl + "chat");
        const details = await openChatDetails(page);
        const key = await waitForWatchedSessionKey(gateway);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [key]: {
              status: "ready",
              rateLimited: false,
              pullRequests: receipt ? [pullRequest(43), pullRequest(44)] : [pullRequest(42)],
            },
          },
        });
        await module.request;
        if (receipt) {
          await gateway.resolveDeferred("sessions.github.options");
        }
        const group = details.locator('[data-details-group="pull-requests"]');
        await group.locator('[role="status"][aria-busy="true"]').waitFor();
        if (!receipt) {
          await capture(page, details, group, "loading");
        }
        const count = receipt ? 3 : 1;
        await nextPaint(page);
        const loading = await group.boundingBox();
        const people = details.locator('[data-details-group="people"] > summary');
        const peopleNode = await people.elementHandle();
        await people.click();
        await expect.poll(() => people.getAttribute("aria-expanded")).toBe("true");
        await people.focus();
        module.release();
        await expect.poll(() => group.locator(".chat-pr[data-state]").count()).toBe(count);
        await group.locator('[aria-busy="true"]').waitFor({ state: "detached" });
        expect(
          await peopleNode!.evaluate(
            (element) => element.isConnected && element === document.activeElement,
          ),
        ).toBe(true);
        expect(await people.getAttribute("aria-expanded")).toBe("true");
        expect((await group.boundingBox())!.height).toBeCloseTo(loading!.height, 0);
        if (!receipt) {
          await capture(page, details, group, "ready");
        }
        expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
      });
    },
  );

  it.each([false, true])(
    "reads Outputs after startup settles and releases hidden demand (history error=%s)",
    async (historyError) => {
      await suite.withPage(options, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          ...scenario,
          authMethod: "trusted-proxy",
          subscriptionInitialHistory: false,
          authMode: "trusted-proxy",
          heldMethods: ["connect", "chat.startup"],
          methodResponses: {
            "artifacts.list": {
              artifacts: [
                {
                  id: "review-notes",
                  title: "Review notes.md",
                  type: "document",
                  download: { mode: "bytes" },
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("chat.startup");
        await gateway.resolveDeferred("chat.startup");
        const transcript = page.getByText("The review document and pull request are ready.", {
          exact: true,
        });
        await transcript.waitFor();
        await page.waitForFunction(() =>
          Object.keys(localStorage).some((key) =>
            key.startsWith("openclaw.control.bootRecord.v1:"),
          ),
        );
        await page.evaluate(async () => {
          const pane = document.querySelector(".chat-pane-cache__pane--active");
          await Reflect.get(pane!, "sessionSnapshotStore").flush();
        });
        const module = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-details-session.tsx"),
        );
        await page.reload();
        await gateway.waitForRequest("connect");
        await transcript.waitFor();
        await module.request;
        await page
          .locator(".chat-details[data-desktop] > openclaw-panel-loading-skeleton")
          .waitFor();
        await nextPaint(page);
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("chat.startup");
        await nextPaint(page);
        expect(
          await gateway.getRequests("artifacts.list", { messageRole: "assistant" }),
        ).toHaveLength(0);
        if (historyError) {
          await gateway.rejectDeferred("chat.startup", {
            code: "UNAVAILABLE",
            message: "History is temporarily unavailable",
          });
        } else {
          await gateway.resolveDeferred("chat.startup");
        }
        await gateway.waitForRequest("artifacts.list", { match: { messageRole: "assistant" } });
        expect(
          await gateway.getRequests("artifacts.list", { messageRole: "assistant" }),
        ).toHaveLength(1);
        const details = page.locator(".chat-details[data-desktop]");
        await closeChatDetails(page);
        await gateway.emitChatFinal({
          runId: "details-hidden-refresh",
          sessionKey,
          text: "The review notes were updated.",
        });
        await page
          .getByRole("paragraph")
          .filter({ hasText: "The review notes were updated." })
          .waitFor();
        await nextPaint(page);
        expect(
          await gateway.getRequests("artifacts.list", { messageRole: "assistant" }),
        ).toHaveLength(1);
        module.release();
        await page.locator(".chat-details-session").waitFor({ state: "attached" });
        await openChatDetails(page);
        await gateway.waitForRequest("artifacts.list", {
          after: 1,
          match: { messageRole: "assistant" },
        });
        await details.locator('[data-details-group="outputs"]').waitFor();
        expect(
          await gateway.getRequests("artifacts.list", { messageRole: "assistant" }),
        ).toHaveLength(2);
      });
    },
  );
});
