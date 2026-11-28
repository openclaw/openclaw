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
      __openclaw: meta(
        runId,
        source === "subagent"
          ? {
              subagentCompletions: [
                { runId: "child-link-check", sessionKey: "agent:main:subagent:link-check" },
              ],
            }
          : {},
      ),
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
  it("uses the shared chat mark for a visible child and the bot for a subagent", async () => {
    const chat = "agent:main:dashboard:release-notes";
    const worker = "agent:main:subagent:link-check";
    await suite.withPage(
      { viewport: { width: 1100, height: 750 }, colorScheme: "dark" },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey,
          historyMessages: [
            { role: "user", content: "Check the links in the release notes.", timestamp: now },
            {
              role: "assistant",
              content: "The conversation is [Release notes](/chat/main/dashboard/release-notes).",
              timestamp: now + 1000,
            },
            {
              role: "assistant",
              phase: "commentary",
              display: true,
              timestamp: now + 2000,
              content: [{ type: "subagent_completion" }],
              subagentCompletions: [
                { sessionKey: chat, runId: "notes", label: "Release notes" },
                { sessionKey: worker, runId: "links", label: "Link check" },
              ],
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const thread = page.locator(".chat-thread");
        const row = thread.locator(".chat-tool-msg-collapse--completion");
        const child = row.getByRole("button", { name: "Release notes", exact: true });
        const subagent = row.getByRole("button", { name: "Link check", exact: true });
        await child.waitFor();
        const link = thread.locator("a.markdown-session-link");
        const sharedMark = await link.evaluate((el) => getComputedStyle(el, "::before").maskImage);
        if (process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR) {
          await thread.screenshot({
            path: path.join(suite.artifactDir, "child-session-icons.png"),
          });
        }
        expect(sharedMark).not.toBe("none");
        expect(await subagent.locator(".chat-subagent-avatar svg").count()).toBe(1);
        expect(await child.locator(".chat-subagent-avatar").count()).toBe(0);
        expect(
          await child
            .locator(".chat-session-link-mark")
            .evaluate((el) => getComputedStyle(el).maskImage),
        ).toBe(sharedMark);
        await child.click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe("/chat/main/dashboard/release-notes");
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
      // one activity row for each wake that continued the work.
      expect(await thread.locator(".chat-group.assistant").count()).toBe(2);
      const agent = thread.locator(".chat-tool-row--subagent", { hasText: "An agent finished" });
      expect(await agent.count()).toBe(1);
      expect(await agent.locator(".chat-tool-row__detail").textContent()).toContain("4m 39s later");
      expect(
        (await thread.locator(".chat-continuation-activity").allTextContents()).map((text) =>
          text.replace(/\s+/gu, " ").trim(),
        ),
      ).toEqual([
        "A background command finished · 3m 40s later",
        "A background command finished · 4m 30s later",
        "A background command finished · 1m 40s later",
      ]);
      await thread.getByText(ANSWER, { exact: true }).waitFor();
      await page.reload();
      await agent.waitFor();
      expect(await agent.count()).toBe(1);
      expect(await agent.locator(".chat-tool-row__detail").textContent()).toContain("4m 39s later");
      expect(await thread.locator(".chat-group.assistant").count()).toBe(2);
    });
  });
});
