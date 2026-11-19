import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { textContent } from "./chat-flow.test-support.ts";
import { swarmSnapshot } from "./chat-swarm.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { recordedToolCall } from "./recorded-tool.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat continuation wakes" });

const sessionKey = "agent:main:dashboard:docs-upgrade";
const FIRST = "Upgrade the docs build and check the preview deploy.";
const SECOND = "Thanks. Can you open the PR?";
const ANSWER = "The preview deploy is green and every page builds.";
const LATE = "The background link check also finished: no broken links.";
const now = Date.UTC(2026, 10, 16, 9, 0);
const minute = 60_000;

// A raw transcript shaped like a long autonomous session; the real Gateway
// projection hides each wake input and marks the row after it.
function activity(id: string, name: string, title: string) {
  return {
    itemId: `tool:${id}`,
    toolCallId: id,
    kind: "tool",
    phase: "end",
    status: "completed",
    name,
    title,
    ...(name === "sessions_yield" ? { hideFromChannelProgress: true } : {}),
  };
}

function history() {
  let seq = 0;
  const rows: unknown[] = [];
  const meta = (runId: string, extra: Record<string, unknown> = {}) => ({
    id: `row-${++seq}`,
    seq,
    runId,
    ...extra,
  });
  const exec = (runId: string, at: number, command: string) => {
    const id = `call-${seq + 1}`;
    rows.push(
      {
        ...recordedToolCall(id, "exec", { command }),
        stopReason: "toolUse",
        timestamp: at,
        __openclaw: meta(runId),
      },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "exec",
        content: textContent("ok"),
        timestamp: at + 1_000,
        activity: [activity(id, "exec", command)],
        __openclaw: meta(runId),
      },
    );
  };
  const tool = (runId: string, at: number, name: string, args: Record<string, unknown>) => {
    const id = `call-${seq + 1}`;
    rows.push(
      {
        ...recordedToolCall(id, name, args),
        stopReason: "toolUse",
        timestamp: at,
        __openclaw: meta(runId),
      },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: textContent(
          JSON.stringify({ status: name === "sessions_yield" ? "yielded" : "accepted" }),
        ),
        timestamp: at + 1_000,
        activity: [activity(id, name, name === "sessions_spawn" ? "Link check" : name)],
        __openclaw: meta(runId),
      },
    );
  };
  const say = (runId: string, at: number, text: string) =>
    rows.push({
      role: "assistant",
      content: text,
      stopReason: "stop",
      timestamp: at,
      __openclaw: meta(runId),
    });
  const wake = (source: "exec" | "subagent", runId: string, at: number) =>
    rows.push({
      role: "user",
      content: source === "exec" ? "Exec completed (code 0)" : "Link check finished.",
      timestamp: at - 1_000,
      provenance:
        source === "exec"
          ? { kind: "internal_system", sourceTool: "exec", runId }
          : {
              kind: "inter_session",
              sourceTool: "subagent_settle",
              sourceSessionKey: "agent:main:subagent:link-check",
            },
      __openclaw: meta(runId),
    });
  rows.push({
    role: "user",
    content: FIRST,
    timestamp: now,
    __openclaw: meta("ask", { idempotencyKey: "ask:user" }),
  });
  exec("ask", now + 10_000, "pnpm docs:build &");
  say(
    "ask",
    now + 20_000,
    "The docs build is running in the background. I’ll check back when it finishes.",
  );
  tool("ask", now + 30_000, "sessions_yield", {});
  wake("exec", "ask", now + 4 * minute);
  exec("build", now + 4 * minute, "pnpm docs:check");
  exec("build", now + 4 * minute + 10_000, "git diff --stat");
  exec("build", now + 4 * minute + 20_000, "pnpm docs:preview &");
  exec("build", now + 4 * minute + 30_000, "sleep 1");
  tool("build", now + 4 * minute + 40_000, "sessions_yield", {});
  wake("exec", "build", now + 9 * minute);
  exec("preview", now + 9 * minute, "curl -s preview/health");
  exec("preview", now + 9 * minute + 10_000, "pnpm docs:links &");
  tool("preview", now + 9 * minute + 20_000, "sessions_spawn", { label: "Link check" });
  tool("preview", now + 9 * minute + 30_000, "sessions_yield", {});
  wake("subagent", "settle", now + 14 * minute);
  exec("settle", now + 14 * minute, "gh run view --log");
  say("settle", now + 14 * minute + 20_000, ANSWER);
  wake("exec", "preview", now + 16 * minute);
  exec("late", now + 16 * minute, "cat links.log");
  say("late", now + 16 * minute + 10_000, LATE);
  rows.push({
    role: "user",
    content: SECOND,
    timestamp: now + 18 * minute,
    __openclaw: meta("next", { idempotencyKey: "next:user" }),
  });
  say("next", now + 18 * minute + 10_000, "Opened the PR with the build and link-check results.");
  return projectChatDisplayMessages(rows);
}

suite.define(() => {
  it("keeps Swarms from earlier runs in the resumed turn after reload", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1400 }, locale: "en-US" },
      async ({ page }) => {
        const child = (id: string, status: string) => ({
          key: "agent:main:subagent:" + id,
          status,
        });
        const groups = [
          ...swarmSnapshot(`swarm:${sessionKey}:preview`, now + 9 * minute, [
            child("link-check", "done"),
          ]).groups,
          ...swarmSnapshot(`swarm:${sessionKey}:build`, now + 4 * minute, [
            child("build-check", "running"),
          ]).groups,
        ];
        await installMockGateway(page, {
          sessionKey,
          sessions: [
            {
              key: sessionKey,
              sessionId: "docs-upgrade",
              kind: "direct",
              label: "Docs upgrade",
              updatedAt: now + 18 * minute,
              swarm: { groups, otherActiveGroups: 0 },
            },
          ],
          historyMessages: history(),
        });
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        const resumedTurn = thread.locator(".chat-group.assistant").filter({
          has: page.getByText(ANSWER, { exact: true }),
        });
        const swarms = resumedTurn.locator('[data-test-id="chat-inline-swarm"]');
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByText(ANSWER, { exact: true }).waitFor();
        expect(await resumedTurn.count()).toBe(1);
        expect(await resumedTurn.locator(".chat-handoff-resume__rule").count()).toBeGreaterThan(0);
        await expect.poll(() => swarms.count()).toBe(2);
        expect(await swarms.getByRole("status").allTextContents()).toEqual([
          "Swarm0 of 1 settled",
          "Swarm1 of 1 settled",
        ]);
        await page.reload();
        await expect.poll(() => swarms.count()).toBe(2);
        expect(await thread.locator('[data-test-id="chat-inline-swarm"]').count()).toBe(2);
      },
    );
  });

  it("keeps self-woken work in the block of the prompt that started it", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1400 } }, async ({ page }) => {
      await page.clock.setFixedTime(now + 20 * minute);
      await page.addInitScript(
        ({ key }) => {
          localStorage.setItem(key, JSON.stringify({ themeMode: "light", navCollapsed: true }));
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
      );
      await installMockGateway(page, {
        sessionKey,
        assistantName: "Roboclaw",
        sessions: [
          {
            key: sessionKey,
            sessionId: "docs-upgrade",
            // A shared session keeps the avatar gutter, as on multi-user Gateways.
            kind: "group",
            label: "Docs upgrade",
            status: "done",
            hasActiveRun: false,
            activeRunIds: [],
            startedAt: now,
            endedAt: now + 18 * minute + 10_000,
            updatedAt: now + 18 * minute + 10_000,
          },
        ],
        historyMessages: history(),
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator(".chat-pane-cache__pane--active");
      const thread = pane.locator(".chat-thread");
      const first = thread.getByText(FIRST, { exact: true });
      const last = thread.getByText("Opened the PR", { exact: false });
      await last.waitFor();
      await thread.getByText(LATE, { exact: true }).waitFor();
      const artifacts = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifacts) {
        const frame = await takeControlUiScreenshotFrame(page, thread, [first, last], {
          animations: "disabled",
        });
        const file = path.join(
          createControlUiE2eArtifactDir("continuation-wakes", artifacts),
          "continuation-wakes.png",
        );
        await writeFile(file, frame.png);
        console.log(`Screenshot: ${file}`);
      }
      // One assistant block per prompt; the earlier answer stays in place above
      // a Resumed rule for each wake that continued the work.
      expect(await thread.locator(".chat-group.assistant").count()).toBe(2);
      expect(
        (await thread.locator(".chat-handoff-resume__rule").allTextContents()).map((text) =>
          text.replace(/\s+/gu, " ").trim(),
        ),
      ).toEqual([
        "Resumed · 3m 40s later · Background command finished",
        "Resumed · 4m 30s later · Background command finished",
        "Resumed · 4m 40s later · Agent finished",
        "Resumed · 1m 40s later · Background command finished",
      ]);
      await thread.getByText(ANSWER, { exact: true }).waitFor();
    });
  });
});
