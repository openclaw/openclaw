import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { textContent } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat yield acknowledgment" });

const REQUEST =
  "Update the docs site dependencies, the CLI dependencies and the CI action pins. Use a separate session for each, and check back when they’re ready to merge.";
const SHORT_ACK =
  "Started the docs dependency session. I’ll check back when it’s ready to merge or needs a decision from you.";
const LONG_ACK = [
  "The docs session stopped before changing anything: the lockfile on its branch is out of date, so I’ve told it to rebase onto `main` and regenerate `pnpm-lock.yaml`. Nothing has been pushed yet.",
  "Something to know before landing: the CLI update raises the minimum Node version. If that needs a release note, I’ll draft one rather than skip it.",
  "I also started sessions for the CLI and CI updates, and I’ll check back as each one is ready to merge.",
].join("\n\n");
const ANSWER =
  "The docs update is ready to merge: CI is green and the lockfile is regenerated on `7c1e2a9`. It’s waiting on your approval.";
const PRIVATE = "PRIVATE_CONTINUATION_CONTEXT";
const FIRST = "Docs site dependencies";
const SECOND = "CLI dependencies";
const THIRD = "CI action pins";

type Scenario = "one-waiting" | "three-waiting" | "resumed";

const parentKey = "agent:main:dependency-updates";
const runId = "parent-run";

type ChildFacts = Partial<
  Pick<
    GatewaySessionRow,
    "status" | "hasActiveRun" | "activeRunIds" | "endedAt" | "runtimeMs" | "agentStatus"
  >
>;

function child(index: number, label: string, row: ChildFacts, now: number) {
  return {
    key: `agent:main:subagent:dependency-update-${index}`,
    sessionId: `dependency-update-${index}`,
    kind: "direct",
    classification: "subagent",
    label,
    parentSessionKey: parentKey,
    spawnedBy: parentKey,
    createdAt: now - 590_000 + index,
    startedAt: now - 590_000 + index,
    updatedAt: now - 1_000,
    ...row,
  } satisfies GatewaySessionRow;
}

function scenarioData(scenario: Scenario, now: number) {
  const yieldedAt = now - 572_000;
  const running: ChildFacts = {
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["child-run"],
  };
  const done: ChildFacts = { status: "done", hasActiveRun: false, activeRunIds: [] };
  const children =
    scenario === "one-waiting"
      ? [child(1, FIRST, running, now)]
      : scenario === "three-waiting"
        ? [
            child(1, FIRST, running, now),
            child(
              2,
              SECOND,
              {
                ...done,
                endedAt: now - 200_000,
                agentStatus: {
                  note: "Needs a decision on the Node minimum",
                  attention: "hand",
                  expiresAt: now + 1_800_000,
                },
              },
              now,
            ),
            child(3, THIRD, { ...done, endedAt: now - 350_000, runtimeMs: 240_000 }, now),
          ]
        : [
            child(1, FIRST, { ...done, endedAt: now - 2_000 }, now),
            child(2, SECOND, { ...done, endedAt: now - 200_000 }, now),
            child(3, THIRD, { ...done, endedAt: now - 350_000 }, now),
          ];
  const acknowledgment = scenario === "one-waiting" ? SHORT_ACK : LONG_ACK;
  const resumed = scenario === "resumed";
  const parent = {
    key: parentKey,
    sessionId: "dependency-updates",
    kind: "direct",
    label: "Dependency updates",
    status: "done",
    hasActiveRun: false,
    activeRunIds: [],
    hasActiveSubagentRun: !resumed,
    childSessions: children.map((row) => row.key),
    startedAt: resumed ? now - 1_500 : now - 600_000,
    endedAt: resumed ? now - 500 : yieldedAt,
    updatedAt: now - 500,
  } satisfies GatewaySessionRow;
  const spawns = children.flatMap((row, index) => [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `spawn-${index}`,
          name: "sessions_spawn",
          arguments: { label: row.label, task: `Review ${row.label}.` },
        },
      ],
      timestamp: now - 590_000 + index * 10,
      __openclaw: { id: `spawn-call-${index}`, seq: 2 + index * 2, runId },
    },
    {
      role: "toolResult",
      toolCallId: `spawn-${index}`,
      toolName: "sessions_spawn",
      content: textContent(JSON.stringify({ status: "accepted", childSessionKey: row.key })),
      timestamp: now - 590_000 + index * 10 + 5,
      __openclaw: { id: `spawn-result-${index}`, seq: 3 + index * 2, runId },
    },
  ]);
  const history = [
    {
      role: "user",
      content: REQUEST,
      timestamp: now - 600_000,
      __openclaw: { id: "request", seq: 1, idempotencyKey: `${runId}:user` },
    },
    ...spawns,
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "handoff",
          name: "sessions_yield",
          arguments: { acknowledgment, message: PRIVATE },
        },
      ],
      timestamp: yieldedAt - 1_000,
      __openclaw: { id: "yield-call", seq: 20, runId },
    },
    {
      role: "toolResult",
      toolCallId: "handoff",
      toolName: "sessions_yield",
      content: textContent(JSON.stringify({ status: "yielded", acknowledgment })),
      timestamp: yieldedAt,
      __openclaw: { id: "yield-result", seq: 21, runId },
    },
    ...(resumed
      ? [
          {
            role: "assistant",
            content: ANSWER,
            stopReason: "stop",
            timestamp: now - 1_000,
            __openclaw: { id: "answer", seq: 23, runId: "parent-resumed-run" },
          },
        ]
      : []),
  ];
  return { parent, children, history };
}

async function openScenario(page: Page, scenario: Scenario) {
  const now = Date.UTC(2026, 9, 27, 5, 30);
  await page.clock.setFixedTime(now);
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(key, JSON.stringify({ themeMode: "light", navCollapsed: true }));
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
  );
  const { parent, children, history } = scenarioData(scenario, now);
  const gateway = await installMockGateway(page, {
    sessionKey: parent.key,
    assistantName: "Roboclaw",
    sessions: [parent, ...children],
    historyMessages: history,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
  const pane = page.locator(".chat-pane-cache__pane--active");
  const thread = pane.locator(".chat-thread");
  const prompt = thread.getByText(REQUEST, { exact: true });
  await prompt.waitFor();
  // The pane's own child query answers before the wait can name its sessions.
  await gateway.waitForRequest("sessions.list", { match: { spawnedBy: parent.key } });
  return { pane, thread, prompt };
}

/** Before/after proof only: set OPENCLAW_UI_E2E_ARTIFACT_DIR to keep the frames. */
async function capture(page: Page, scope: string, pane: Locator, targets: Locator[]) {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  if (!parent) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, pane, targets, {
    animations: "disabled",
  });
  const file = path.join(createControlUiE2eArtifactDir(scope, parent), `${scope}.png`);
  await writeFile(file, frame.png);
  console.log(`Screenshot: ${file}`);
}

const squash = (text: string | null) => text?.replace(/\s+/gu, " ").trim();

suite.define(() => {
  it("speaks a short acknowledgment and names the one session it waits on", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { pane, thread, prompt } = await openScenario(page, "one-waiting");
      const ack = thread.getByText(SHORT_ACK, { exact: true });
      const wait = thread.locator(".chat-subagent-wait");
      await ack.waitFor();
      await thread.locator(".chat-working-indicator").waitFor();
      await capture(page, "one-waiting", pane, [prompt, ack]);
      await thread.locator(".chat-group.assistant .chat-text").getByText(SHORT_ACK).waitFor();
      expect(await thread.locator(".chat-notice").count()).toBe(0);
      await expect
        .poll(async () => squash(await wait.textContent()))
        .toBe(`Waiting on ${FIRST} · 10m`);
      expect(await wait.locator("button[aria-expanded]").count()).toBe(0);
      expect(await wait.locator("a").getAttribute("href")).toBe(
        "/chat/main/subagent/dependency-update-1",
      );
      expect(await thread.textContent()).not.toContain(PRIVATE);
    });
  });

  it("speaks a long acknowledgment and lists the sessions it waits on", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { pane, thread, prompt } = await openScenario(page, "three-waiting");
      const lastParagraph = thread.getByText("I also started sessions for the CLI and CI updates", {
        exact: false,
      });
      await lastParagraph.waitFor();
      await thread.locator(".chat-working-indicator").waitFor();
      await capture(page, "three-waiting", pane, [prompt, lastParagraph]);
      await thread
        .locator(".chat-group.assistant .chat-text p")
        .filter({ hasText: "Something to know before landing" })
        .waitFor();
      expect(await thread.locator(".chat-notice").count()).toBe(0);
      const wait = thread.locator(".chat-subagent-wait");
      const toggle = wait.locator("button[aria-expanded]");
      await expect
        .poll(async () => squash(await toggle.textContent()))
        .toBe("Waiting on 3 sessions · 1 needs your input · 10m");
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      const rows = wait.locator("li");
      expect((await rows.allTextContents()).map(squash)).toEqual([
        `${SECOND} Needs your input`,
        `${FIRST} Running`,
        `${THIRD} Done`,
      ]);
      expect(
        await rows.locator("a").evaluateAll((links) => links.map((a) => a.getAttribute("href"))),
      ).toEqual([
        "/chat/main/subagent/dependency-update-2",
        "/chat/main/subagent/dependency-update-1",
        "/chat/main/subagent/dependency-update-3",
      ]);
      await toggle.click();
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await rows.first().isVisible()).toBe(false);
    });
  });

  it("keeps the acknowledgment after resume and folds the wait into a rule", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { pane, thread, prompt } = await openScenario(page, "resumed");
      const answer = thread.getByText("The docs update is ready to merge", { exact: false });
      await answer.waitFor();
      const rule = thread.locator(".chat-handoff-resume");
      const toggle = rule.locator("button[aria-expanded]");
      // Closed after resume; it opens to the sessions the handoff waited on.
      await toggle.waitFor();
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await toggle.click();
      await rule.locator("li").first().waitFor();
      await capture(page, "resumed", pane, [prompt, answer]);
      await thread
        .locator(".chat-group.assistant .chat-text p")
        .filter({ hasText: "Something to know before landing" })
        .waitFor();
      expect(squash(await toggle.textContent())).toBe("Resumed · 9m 32s later · 3 sessions");
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      expect((await rule.locator("li").allTextContents()).map(squash)).toEqual([
        `${FIRST} Done`,
        `${SECOND} Done`,
        `${THIRD} Done`,
      ]);
      expect(await thread.locator(".chat-group.assistant").count()).toBe(1);
      expect(await thread.locator(".chat-notice").count()).toBe(0);
      expect(await thread.textContent()).not.toContain(PRIVATE);
      // A listed child opens its own session in place.
      await rule.locator("li a", { hasText: SECOND }).click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe("/chat/main/subagent/dependency-update-2");
      await expect
        .poll(() => pane.locator(".chat-pane__session-title-text").first().textContent())
        .toBe(SECOND);
    });
  });
});
