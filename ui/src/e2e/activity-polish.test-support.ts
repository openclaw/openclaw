import type { Page } from "playwright";
import type { ControlUiSessionPullRequestsChanged } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  defaultControlUiFeatureMethods,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";

export const activityPolishKeys = {
  current: "agent:main:polish-current",
  updating: "agent:main:polish-updating",
  unavailable: "agent:main:polish-unavailable",
  initial: "agent:main:polish-initial",
};
export const activityPolishPullRequest = {
  owner: "example",
  repo: "notification-service",
  number: 42,
  branch: "fix/reconnect-notifications",
  title: "Prevent duplicate notifications after reconnecting",
  url: "https://github.com/example/notification-service/pull/42",
  state: "merged" as const,
  additions: 84,
  deletions: 21,
};

export function activityPolishFixture(now = Date.now()) {
  const sessions = [
    {
      key: activityPolishKeys.current,
      label: "Repair duplicate notifications",
      lastActivityAt: now - 40 * 60_000,
      lastInteractionAt: now - 60_000,
      text: "Fixed duplicate notifications after reconnecting. Regression checks passed and the pull request was merged.",
      state: "current",
    },
    {
      key: activityPolishKeys.updating,
      label: "Improve keyboard navigation",
      lastActivityAt: now - 8 * 60_000,
      text: "Added keyboard navigation to the project switcher. Testing focus behavior on smaller screens.",
      state: "updating",
    },
    {
      key: activityPolishKeys.unavailable,
      label: "Investigate slow image previews",
      lastActivityAt: now - 26 * 60_000,
      text: "Found repeated image downloads during navigation. The cache repair is ready for review.",
      state: "unavailable",
    },
    {
      key: activityPolishKeys.initial,
      label: "Review release checklist",
      lastActivityAt: now - 45 * 60_000,
      text: "",
      state: "updating",
    },
  ].map(({ text, state, ...row }, index) =>
    Object.assign(row, {
      kind: "direct" as const,
      agentId: "main",
      sessionId: `activity-polish-${index}`,
      updatedAt: now - (index + 1) * 3_600_000,
      createdActor: { type: "human", id: "alex-example", label: "Alex Morgan" },
      activitySummary: { state, canEnsure: true, text, updatedAt: now - 3_600_000 },
    }),
  );
  const list = {
    count: sessions.length,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions,
    ts: now,
  };
  const scenario: ControlUiMockGatewayScenario = {
    assistantName: "Roboclaw",
    sessionKey: activityPolishKeys.current,
    featureMethods: [...defaultControlUiFeatureMethods, SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
    heldMethods: ["sessions.list", "controlUi.githubPreview"],
    methodResponses: {
      "sessions.list": list,
      [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      "artifacts.list": { artifacts: [] },
    },
  };
  const pullRequests: ControlUiSessionPullRequestsChanged = {
    sessions: {
      [activityPolishKeys.current]: {
        pullRequests: [activityPolishPullRequest],
        rateLimited: false,
        status: "ready",
      },
    },
  };
  return { list, scenario, pullRequests };
}

export async function activityPolishImages(page: Page) {
  const urls = await page.evaluate(() =>
    ["Reconnect check", "Delivery timeline", "Keyboard review", "Preview cache"].map(
      (title, index) => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 450;
        const context = canvas.getContext("2d")!;
        context.fillStyle = ["#eff6ff", "#f0fdf4", "#faf5ff", "#fff7ed"][index]!;
        context.fillRect(0, 0, 800, 450);
        context.fillStyle = "#172033";
        context.font = "600 32px sans-serif";
        context.fillText(title, 40, 65);
        context.font = "19px sans-serif";
        context.fillStyle = "#64748b";
        context.fillText("Synthetic validation screenshot", 40, 100);
        for (let row = 0; row < 4; row++) {
          context.fillStyle = "#ffffff";
          context.fillRect(40, 130 + row * 65, 720, 50);
          context.fillStyle = "#15803d";
          context.font = "22px sans-serif";
          context.fillText("✓", 58, 164 + row * 65);
          context.fillStyle = "#334155";
          context.font = "19px sans-serif";
          context.fillText(
            [
              "Connection restored",
              "One notification delivered",
              "No duplicate requests",
              "Checks passed",
            ][row]!,
            96,
            163 + row * 65,
          );
        }
        return canvas.toDataURL("image/png");
      },
    ),
  );
  return {
    artifacts: urls.map((url, index) => ({
      id: `screenshot-${index + 1}`,
      type: "image",
      title: ["Reconnect check", "Delivery timeline", "Keyboard review", "Preview cache"][index]!,
      mimeType: "image/png",
      sessionKey: activityPolishKeys.current,
      image: { url },
      download: { mode: "url" },
    })),
  };
}
