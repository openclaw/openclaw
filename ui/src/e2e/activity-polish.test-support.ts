import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { ControlUiSessionPullRequestsChanged } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  defaultControlUiFeatureMethods,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";

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
  const sessions = (
    [
      ["current", "Repair duplicate notifications", 40, "Fixed duplicate notifications."],
      ["updating", "Improve keyboard navigation", 8, "Testing focus behavior."],
      ["unavailable", "Investigate slow image previews", 26, "Cache repair ready for review."],
      ["initial", "Review release checklist", 45, ""],
    ] as const
  ).map(([name, label, minutes, text], index) => ({
    key: activityPolishKeys[name],
    label,
    lastActivityAt: now - minutes * 60_000,
    lastInteractionAt: name === "current" ? now - 60_000 : undefined,
    kind: "direct" as const,
    agentId: "main",
    sessionId: `activity-polish-${index}`,
    updatedAt: now - (index + 1) * 3_600_000,
    createdActor: { type: "human", id: "alex-example", label: "Alex Morgan" },
    activitySummary: {
      state: name === "initial" ? "updating" : name,
      canEnsure: true,
      text,
      updatedAt: now - 3_600_000,
    },
  }));
  const list = { ...chatSessionListResponse(sessions), ts: now };
  const scenario: ControlUiMockGatewayScenario = {
    assistantName: "Roboclaw",
    sessionKey: activityPolishKeys.current,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      TEST_LINK_READER.linkReader.previewMethod!,
      TEST_LINK_READER.linkReader.detailMethod,
    ],
    controlUiLinkReaders: [TEST_LINK_READER],
    heldMethods: ["sessions.list", TEST_LINK_READER.linkReader.previewMethod!],
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
  const titles = ["Reconnect check", "Delivery timeline", "Keyboard review", "Preview cache"];
  const urls = await page.evaluate((captions) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 450;
    const context = canvas.getContext("2d")!;
    return captions.map((title, index) => {
      context.fillStyle = `hsl(${index * 90} 40% 95%)`;
      context.fillRect(0, 0, 800, 450);
      context.fillStyle = "#172033";
      context.fillText(title, 40, 65);
      return canvas.toDataURL("image/png");
    });
  }, titles);
  return {
    artifacts: titles.map((title, index) => ({
      id: `screenshot-${index + 1}`,
      type: "image",
      title,
      mimeType: "image/png",
      sessionKey: activityPolishKeys.current,
      image: { url: urls[index]! },
      download: { mode: "url" },
    })),
  };
}

export async function expectActivityImagesLoaded(images: Locator) {
  await expect
    .poll(() =>
      images.evaluateAll(
        (elements) =>
          elements.length > 0 &&
          elements.every(
            (element) =>
              element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
          ),
      ),
    )
    .toBe(true);
}
