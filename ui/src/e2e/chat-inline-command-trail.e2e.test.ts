import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
  controlUiSessionUrl,
  installMockGateway,
  reconnectMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI inline command trail" });
const sessionKey = "agent:main:dashboard:inline-command-trail";
const textContent = (text: string) => [{ type: "text", text }];

async function toggleInline(pane: Locator, enabled: boolean) {
  const trigger = pane.locator(".chat-header-session-menu__trigger");
  await trigger.click();
  const menu = pane.locator("openclaw-chat-header-session-menu > .chat-header-session-menu");
  await menu.getByRole("menuitem", { name: "View", exact: true }).hover();
  const option = menu.getByRole("menuitemcheckbox", {
    name: "Inline command trail (this browser)",
    exact: true,
  });
  await option.click();
  await expect.poll(() => option.getAttribute("aria-checked")).toBe(String(enabled));
  // Escape in the composer stops a live run; close the menu through its trigger.
  await trigger.click();
}

async function startRun(page: Page, bubbles = false) {
  const row = {
    key: sessionKey,
    sessionId: "inline-command-session",
    kind: "direct",
    verboseLevel: "full",
    updatedAt: 1_000,
  };
  const gateway = await installMockGateway(page, {
    sessionKey,
    sessionInfo: row,
    sessions: [row],
    historyMessages: [],
  });
  if (bubbles) {
    await page.route("**/control-ui-config.json", (route) =>
      route.fulfill({
        json: { ...createControlUiMockBootstrapConfig(), chatBubblesEnabled: true },
      }),
    );
  }
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  await pane.locator(".agent-chat__composer-combobox textarea").fill("Run the evidence commands.");
  await pane.getByRole("button", { name: "Send message" }).click();
  const send = await gateway.waitForRequest("chat.send");
  const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
  let seq = 0;
  const now = Date.now();
  const events: {
    runId: string;
    sessionKey: string;
    seq: number;
    ts: number;
    stream: string;
    data: Record<string, unknown>;
  }[] = [];
  const emit = (stream: string, data: Record<string, unknown>) => {
    const event = {
      runId,
      sessionKey,
      seq: ++seq,
      ts: now + seq,
      stream,
      data,
    };
    events.push(event);
    return gateway.emitGatewayEvent("agent", event);
  };
  const tool = async (toolCallId: string, data: Record<string, unknown>) => {
    await emit("tool", { name: "exec", toolCallId, ...data });
    if (data.phase === "start" || data.phase === "result") {
      await emit("item", {
        itemId: `tool:${toolCallId}`,
        toolCallId,
        name: "exec",
        kind: "tool",
        phase: data.phase === "start" ? "start" : "end",
        status: data.phase === "start" ? "running" : data.isError ? "failed" : "completed",
        title: "Run evidence command",
        commandBearing: true,
      });
    }
  };
  await emit("lifecycle", { phase: "start" });
  return { gateway, pane, row, runId, now, tool, emit, events };
}

function command(pane: Locator, text: string) {
  return pane.locator(".chat-tool-msg-collapse", { hasText: text });
}

async function saveHistory(
  gateway: MockGatewayControls,
  history: Record<string, unknown> & { messages: unknown[] },
) {
  await gateway.setHistoryMessages(history.messages);
  await gateway.setMethodResponse("chat.startup", history);
  await gateway.setMethodResponse("chat.history", history);
}

suite.define(() => {
  it("caps wrapped live previews at three visual rows while keeping the newest output visible", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const { pane, tool } = await startRun(page);
        await toggleInline(pane, true);
        await tool("wrapped", { phase: "start", args: { command: "printf wrapped-output" } });
        const current = command(pane, "printf wrapped-output");
        const preview = current.locator(".chat-command-trail__preview pre");
        const output = `Captured beginning.\nPrevious phase.\n${"current output ".repeat(28)}LATEST: ready.`;
        await tool("wrapped", { phase: "update", partialResult: { content: textContent(output) } });
        await expect.poll(() => preview.textContent()).toBe(output);
        const measurements = [];
        for (const width of [1200, 820, 400]) {
          await page.setViewportSize({ width, height: 800 });
          const frame = await takeControlUiScreenshotFrame(page, pane, [current], {
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, `wrapped-preview-${width}.png`), frame.png);
          measurements.push(
            await preview.evaluate((element) => {
              const bounds = element.parentElement!.getBoundingClientRect();
              const range = document.createRange();
              range.setStart(
                element.firstChild!,
                element.textContent!.length - "LATEST: ready.".length,
              );
              range.setEnd(element.firstChild!, element.textContent!.length);
              const newest = range.getBoundingClientRect();
              return {
                rows: bounds.height / Number.parseFloat(getComputedStyle(element).lineHeight),
                newestVisible: newest.top >= bounds.top - 1 && newest.bottom <= bounds.bottom + 1,
              };
            }),
          );
        }
        for (const measurement of measurements) {
          expect(measurement.rows).toBeLessThanOrEqual(3.05);
          expect(measurement.newestVisible).toBe(true);
        }
        expect(await current.getByText("Earlier output omitted", { exact: true }).count()).toBe(0);
        const row = current.locator(".chat-tool-row");
        await row.click();
        await expect
          .poll(() => current.locator(".chat-tool-msg-body").textContent())
          .toContain(output);
        await row.click();
        const next = `${output}\nLATEST: finished.`;
        await tool("wrapped", { phase: "update", partialResult: { content: textContent(next) } });
        await expect.poll(() => preview.textContent()).toContain("LATEST: finished.");
        await current.getByRole("button", { name: "Expand for more output" }).click();
        await expect
          .poll(() => current.locator(".chat-tool-msg-body").textContent())
          .toContain(next);
      },
    );
  });

  it("keeps the live speech bubble on the running noncommand after splitting a mixed trail", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        await page.addInitScript(
          ({ key, session }) => {
            localStorage.setItem(key, JSON.stringify({ chatBubbleSessionKeys: [session] }));
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), session: sessionKey },
        );
        const { pane, emit, tool } = await startRun(page, true);
        await expect
          .poll(() => pane.locator("section.chat").getAttribute("class"))
          .toMatch(/chat--bubbles/u);
        const lookup = async (id: string, title: string, completed: boolean) => {
          await emit("tool", {
            toolCallId: id,
            name: "lookup_record",
            phase: completed ? "result" : "start",
            ...(completed
              ? { result: { content: textContent("Record checked.") } }
              : { args: { query: title } }),
          });
          await emit("item", {
            itemId: `tool:${id}`,
            toolCallId: id,
            name: "lookup_record",
            kind: "tool",
            title,
            phase: completed ? "end" : "start",
            status: completed ? "completed" : "running",
          });
        };
        await lookup("earlier-record", "Inspect earlier record", false);
        await lookup("earlier-record", "Inspect earlier record", true);
        await tool("middle-command", { phase: "start", args: { command: "printf checked" } });
        await tool("middle-command", {
          phase: "result",
          result: { content: textContent("checked") },
        });
        await lookup("release-record", "Inspect release notes", false);
        const groups = pane.locator(".chat-activity-group");
        const working = pane.locator(".chat-activity-group--working");
        await expect
          .poll(() => working.locator(".chat-activity-group__label").textContent())
          .toContain("Inspect release notes");
        const before = await takeControlUiScreenshotFrame(page, pane, [working], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "bubble-mixed-trail-grouped.png"), before.png);

        await toggleInline(pane, true);
        await expect.poll(() => groups.count()).toBe(3);
        await command(pane, "printf checked").waitFor();
        expect(await groups.nth(1).textContent()).toContain("printf checked");
        expect(await groups.last().textContent()).toContain("Inspect release notes");
        expect(await groups.first().locator(".chat-bubble-dots--working").count()).toBe(0);
        expect(await working.count()).toBe(1);
        expect(await pane.locator(".chat-bubble-dots--working").count()).toBe(1);
        expect(await working.locator(".chat-activity-group__label").textContent()).toContain(
          "Inspect release notes",
        );
        expect(await groups.last().locator(".chat-bubble-dots--working").count()).toBe(1);
        const after = await takeControlUiScreenshotFrame(
          page,
          pane,
          [groups.last(), command(pane, "printf checked")],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "bubble-mixed-trail-inline.png"), after.png);
      },
    );
  });

  it("switches a live turn to compact incremental output and restores its completed trail after reload", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, locale: "en-US" },
      async ({ page }) => {
        const { gateway, pane, row, runId, now, tool } = await startRun(page);
        const firstCommand = "printf evidence-first";
        const secondCommand = "printf evidence-failed";
        const output = "phase one\nphase two\nphase three\nphase four\nphase five\n";
        await tool("first", { phase: "start", args: { command: firstCommand } });
        await tool("second", { phase: "start", args: { command: secondCommand } });
        await pane.locator(".chat-activity-group__summary").waitFor();
        expect(await pane.locator(".chat-activity-group--inline").count()).toBe(0);
        await toggleInline(pane, true);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        const first = command(pane, firstCommand);
        const firstRow = first.locator(".chat-tool-row");
        await firstRow.waitFor();
        // Full verbosity must not turn opt-in inline previews into expanded cards.
        expect(await firstRow.getAttribute("aria-expanded")).toBe("false");
        await tool("first", {
          phase: "update",
          partialResult: { content: textContent("phase one\nphase two\n") },
        });
        const preview = first.locator(".chat-command-trail__preview pre");
        await expect.poll(() => preview.textContent()).toBe("phase one\nphase two");
        expect(await firstRow.getAttribute("aria-expanded")).toBe("false");
        await tool("first", { phase: "update", partialResult: { content: textContent(output) } });
        await expect.poll(() => preview.textContent()).toBe("phase three\nphase four\nphase five");
        expect(await first.getByText("Earlier output omitted", { exact: true }).count()).toBe(0);
        await first.getByRole("button", { name: "Expand for more output" }).click();
        await expect.poll(() => firstRow.getAttribute("aria-expanded")).toBe("true");
        await expect
          .poll(() => first.locator(".chat-tool-msg-body").textContent())
          .toContain(output.trimEnd());
        await firstRow.click();
        await expect.poll(() => preview.isVisible()).toBe(true);

        await tool("first", {
          phase: "result",
          result: {
            content: textContent(output),
            details: { status: "completed", exitCode: 0, durationMs: 9 },
          },
        });
        const second = command(pane, secondCommand);
        await second.locator(".chat-tool-row--running").waitFor();
        await first.getByText("Completed", { exact: true }).waitFor();
        expect(await first.isVisible()).toBe(true);
        expect(await first.locator(".chat-tool-row--running").count()).toBe(0);
        expect(await preview.textContent()).toBe("phase three\nphase four\nphase five");
        expect(await first.textContent()).not.toContain("exitCode");
        await tool("second", {
          phase: "result",
          isError: true,
          result: {
            content: textContent("deliberate command failure"),
            details: { status: "failed", exitCode: 1, durationMs: 4 },
          },
        });
        await second.getByText("Exit code 1", { exact: true }).waitFor();
        expect(await second.locator(".chat-tool-row--running").count()).toBe(0);
        await expect
          .poll(() => second.locator(".chat-command-trail__preview pre").textContent())
          .toBe("deliberate command failure");

        const history = {
          sessionId: row.sessionId,
          sessionInfo: { ...row, hasActiveRun: false, activeRunIds: [], status: "idle" },
          messages: [
            {
              role: "user",
              content: "Run the evidence commands.",
              timestamp: now - 1,
              __openclaw: { id: "saved-user", runId },
            },
            ...[
              { id: "first", shellCommand: firstCommand, text: output, isError: false },
              {
                id: "second",
                shellCommand: secondCommand,
                text: "deliberate command failure",
                isError: true,
              },
            ].flatMap(({ id, shellCommand, text, isError }, index) => [
              {
                role: "assistant",
                content: [
                  { type: "toolCall", id, name: "exec", arguments: { command: shellCommand } },
                ],
                timestamp: now + index * 10,
                __openclaw: { id: `call-${id}`, runId },
              },
              {
                role: "toolResult",
                toolCallId: id,
                toolName: "exec",
                content: textContent(text),
                isError,
                activity: [
                  {
                    itemId: `tool:${id}`,
                    toolCallId: id,
                    name: "exec",
                    kind: "tool",
                    phase: "end",
                    status: isError ? "failed" : "completed",
                    title: "Run evidence command",
                    commandBearing: true,
                  },
                ],
                timestamp: now + index * 10 + 1,
                __openclaw: { id: `result-${id}`, runId },
              },
            ]),
            {
              role: "assistant",
              content: textContent("The evidence commands finished."),
              timestamp: now + 50,
              __openclaw: { id: "saved-answer", runId },
            },
          ],
        };
        await saveHistory(gateway, history);
        await gateway.emitChatFinal({ runId, sessionKey, text: "The evidence commands finished." });
        const answer = pane
          .locator(".chat-text")
          .getByText("The evidence commands finished.", { exact: true });
        await answer.waitFor();
        await page.reload();
        await answer.waitFor();
        const worked = pane.locator(".chat-work-group > .chat-activity-group__summary");
        await worked.waitFor();
        expect(await worked.getAttribute("aria-expanded")).toBe("false");
        expect(await first.isVisible()).toBe(false);
        await writeFile(
          path.join(suite.artifactDir, "inline-completed-collapsed.png"),
          (await takeControlUiScreenshotFrame(page, pane, [worked], { animations: "disabled" }))
            .png,
        );
        await worked.click();
        await firstRow.waitFor();
        await expect.poll(() => preview.textContent()).toBe("phase three\nphase four\nphase five");
        expect(
          await pane.locator(".chat-activity-group--inline .chat-tool-row__cmd").allTextContents(),
        ).toEqual([firstCommand, secondCommand]);
        expect(await firstRow.getAttribute("aria-expanded")).toBe("false");
        await writeFile(
          path.join(suite.artifactDir, "inline-completed-expanded.png"),
          (
            await takeControlUiScreenshotFrame(page, pane, [worked, first, second], {
              animations: "disabled",
            })
          ).png,
        );
        await firstRow.click();
        await expect
          .poll(() => first.locator(".chat-tool-msg-body").textContent())
          .toContain(output.trimEnd());
      },
    );
  });

  it("recovers a running trail across reconnect and reload, then settles a visible Stop without inventing success", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, locale: "en-US" },
      async ({ page }) => {
        const { gateway, pane, row, runId, now, tool, emit, events } = await startRun(page);
        await toggleInline(pane, true);
        const firstCommand = "printf recovery-complete";
        const runningCommand = "printf recovery-running";
        const capturedOutput = "Started validation.\nChecked workspace.\nWaiting for completion.";
        const newestOutput = "Newest stdout after capture fills.";
        await tool("recovery-complete", { phase: "start", args: { command: firstCommand } });
        await tool("recovery-complete", {
          phase: "result",
          result: { content: textContent("Completed check."), details: { exitCode: 0 } },
        });
        for (const completed of [false, true]) {
          await emit("tool", {
            toolCallId: "recovery-record",
            name: "lookup_record",
            phase: completed ? "result" : "start",
            ...(completed
              ? { result: { content: textContent("Recovery record checked.") } }
              : { args: { query: "recovery evidence" } }),
          });
          await emit("item", {
            itemId: "tool:recovery-record",
            toolCallId: "recovery-record",
            name: "lookup_record",
            kind: "tool",
            title: "Inspect recovery record",
            phase: completed ? "end" : "start",
            status: completed ? "completed" : "running",
          });
        }
        await tool("recovery-running", { phase: "start", args: { command: runningCommand } });
        await tool("recovery-running", {
          phase: "update",
          partialResult: {
            content: textContent(capturedOutput),
            liveOutput: { text: `${newestOutput}\n`, omittedChars: 12_000 },
          },
        });
        const first = command(pane, firstCommand);
        const running = command(pane, runningCommand);
        const firstRow = first.locator(".chat-tool-row");
        const runningRow = running.locator(".chat-tool-row");
        await running.locator(".chat-tool-row--running").waitFor();
        await firstRow.click();
        await expect.poll(() => firstRow.getAttribute("aria-expanded")).toBe("true");
        const recordSummary = pane.locator(
          ".chat-activity-group:not(.chat-activity-group--inline) .chat-activity-group__summary",
        );
        await expect.poll(() => recordSummary.count()).toBe(1);
        await recordSummary.click();
        await expect.poll(() => recordSummary.getAttribute("aria-expanded")).toBe("true");

        const messages = [
          {
            role: "user",
            content: "Run the evidence commands.",
            timestamp: now - 1,
            __openclaw: { id: "recovery-user", runId },
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "recovery-complete",
                name: "exec",
                arguments: { command: firstCommand },
              },
            ],
            timestamp: now,
            __openclaw: { id: "call-recovery-complete", runId },
          },
          {
            role: "toolResult",
            toolCallId: "recovery-complete",
            toolName: "exec",
            content: textContent("Completed check."),
            timestamp: now + 1,
            __openclaw: { id: "result-recovery-complete", runId },
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "recovery-record",
                name: "lookup_record",
                arguments: { query: "recovery evidence" },
              },
            ],
            timestamp: now + 2,
            __openclaw: { id: "call-recovery-record", runId },
          },
          {
            role: "toolResult",
            toolCallId: "recovery-record",
            toolName: "lookup_record",
            content: textContent("Recovery record checked."),
            timestamp: now + 3,
            __openclaw: { id: "result-recovery-record", runId },
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "recovery-running",
                name: "exec",
                arguments: { command: runningCommand },
              },
            ],
            timestamp: now + 10,
            __openclaw: { id: "call-recovery-running", runId },
          },
        ];
        // Full progress snapshots retain tool starts/results and the latest item per ID.
        const replay = events.filter(
          ({ stream, data }) =>
            stream === "tool" ||
            (stream === "item" &&
              !(data.phase === "start" && data.toolCallId !== "recovery-running")),
        );
        const activeHistory = {
          sessionId: row.sessionId,
          sessionInfo: { ...row, hasActiveRun: true, activeRunIds: [runId], status: "running" },
          messages,
          inFlightRun: { runId, startedAt: now, text: "", events: replay },
        };
        await saveHistory(gateway, activeHistory);
        const expectTrail = async () => {
          await expect
            .poll(() =>
              pane.locator(".chat-activity-group--inline .chat-tool-row__cmd").allTextContents(),
            )
            .toEqual([firstCommand, runningCommand]);
          await expect
            .poll(() => running.locator(".chat-command-trail__preview pre").textContent())
            .toBe(newestOutput);
        };
        const subscriptionCount = (await gateway.getRequests("sessions.messages.subscribe")).length;
        await reconnectMockGateway(page, gateway);
        await gateway.waitForRequest("sessions.messages.subscribe", { after: subscriptionCount });
        await expectTrail();
        expect(await firstRow.getAttribute("aria-expanded")).toBe("true");
        expect(await recordSummary.getAttribute("aria-expanded")).toBe("true");
        expect(await runningRow.getAttribute("aria-expanded")).toBe("false");
        expect(await running.locator(".chat-tool-row--running").count()).toBe(1);
        await runningRow.click();
        await expect
          .poll(() => running.locator(".chat-tool-msg-body").textContent())
          .toContain(capturedOutput);
        await runningRow.click();

        await page.reload();
        const stop = pane.getByRole("button", { name: "Stop", exact: true });
        await stop.waitFor();
        await expectTrail();
        // Disclosure maps are page-local; the browser's inline preference persists.
        expect(await firstRow.getAttribute("aria-expanded")).toBe("false");
        expect(await recordSummary.getAttribute("aria-expanded")).toBe("false");
        expect(await runningRow.getAttribute("aria-expanded")).toBe("false");
        expect(await running.locator(".chat-tool-row--running").count()).toBe(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await runningRow.click();
        await expect
          .poll(() => running.locator(".chat-tool-msg-body").textContent())
          .toContain(capturedOutput);
        await runningRow.click();

        await saveHistory(gateway, {
          ...activeHistory,
          sessionInfo: { ...row, hasActiveRun: false, activeRunIds: [], status: "killed" },
          inFlightRun: null,
        });
        await gateway.setMethodResponse("chat.abort", { ok: true, aborted: true, runIds: [runId] });
        await stop.click();
        const abort = await gateway.waitForRequest("chat.abort");
        expect(abort.params).toEqual({ sessionKey, runId, userInitiated: true });
        await stop.waitFor({ state: "detached" });
        expect(await pane.locator(".chat-tool-row--running").count()).toBe(0);
        await running.getByText("Outcome unknown", { exact: true }).waitFor();
        expect(await running.getByText("Completed", { exact: true }).count()).toBe(0);
        expect(await running.getByText(newestOutput, { exact: true }).count()).toBe(0);
        // A native result owns retained output. This interrupted call has no
        // durable result, while the earlier completed command still has one.
        await firstRow.click();
        await expect
          .poll(() => first.locator(".chat-tool-msg-body").textContent())
          .toContain("Completed check.");
      },
    );
  });

  it("keeps a reader's scroll position while commands append and resumes following at the end", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 480 }, locale: "en-US" },
      async ({ page }) => {
        const { pane, tool } = await startRun(page);
        await toggleInline(pane, true);
        const thread = pane.locator(".chat-thread");
        const geometry = () =>
          thread.evaluate((element) => ({
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            distanceFromEnd: element.scrollHeight - element.scrollTop - element.clientHeight,
          }));
        let count = 0;
        const appendCommands = async (amount: number) => {
          for (let index = 0; index < amount; index += 1) {
            const id = `scroll-${++count}`;
            await tool(id, { phase: "start", args: { command: `printf evidence-${count}` } });
            await tool(id, {
              phase: "result",
              result: { content: textContent(`Evidence ${count}\nChecked.\nReady.`) },
            });
          }
          await expect.poll(() => pane.locator(".chat-command-trail__preview").count()).toBe(count);
        };
        await appendCommands(12);
        await expect.poll(async () => (await geometry()).scrollHeight).toBeGreaterThan(480);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeLessThanOrEqual(8);
        await thread.hover();
        await page.mouse.wheel(0, -240);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeGreaterThan(100);
        const released = await geometry();
        await appendCommands(4);
        await expect
          .poll(async () => (await geometry()).scrollHeight)
          .toBeGreaterThan(released.scrollHeight);
        expect((await geometry()).scrollTop).toBe(released.scrollTop);
        await page.mouse.wheel(0, 100_000);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeLessThanOrEqual(8);
        await appendCommands(2);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeLessThanOrEqual(8);
      },
    );
  });
});
