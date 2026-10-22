import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Collaborator transcript scroll" });
type ScrollPoint = { top: number; distance: number; keys: string[] };
type SamplingThread = HTMLElement & {
  scrollProbe: {
    read: () => ScrollPoint;
    samples: number[];
    stop: () => void;
  };
};

async function watchScroll(thread: Locator) {
  const before = await thread.evaluate((element) => {
    const read = (): ScrollPoint => ({
      top: element.scrollTop,
      distance: element.scrollHeight - element.clientHeight - element.scrollTop,
      keys: [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].map(
        (row) => row.dataset.virtualRowKey!,
      ),
    });
    const samples: number[] = [];
    let frame = 0;
    const tick = () => {
      samples.push(element.scrollTop);
      frame = requestAnimationFrame(tick);
    };
    (element as SamplingThread).scrollProbe = {
      read,
      samples,
      stop: () => cancelAnimationFrame(frame),
    };
    frame = requestAnimationFrame(tick);
    return {
      ...read(),
      frameKey: element.querySelector<HTMLElement>(
        '.chat-virtual-row[data-virtual-row-key^="agent-run:"]',
      )?.dataset.virtualRowKey,
    };
  });
  return {
    before,
    count: () =>
      thread.evaluate((element) => (element as SamplingThread).scrollProbe.samples.length),
    stop: () =>
      thread.evaluate((element) => {
        const probe = (element as SamplingThread).scrollProbe;
        probe.stop();
        return { ...probe.read(), samples: probe.samples };
      }),
  };
}

suite.define(() => {
  it.each(["following", "reading"] as const)(
    "preserves reader intent when a collaborator sends a follow-up while %s",
    async (mode) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 860 }, colorScheme: "dark" },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:collaborator-scroll";
          const runId = "active-review";
          const now = Date.now() - 60_000;
          const finding = "The workspace is organized into independent components. ".repeat(5);
          const history = [
            {
              role: "user",
              content: "Inspect the workspace and explain your findings.",
              timestamp: now,
              __openclaw: { id: "original-user", idempotencyKey: runId + ":user", seq: 1 },
            },
            ...Array.from({ length: 12 }, (_, index) => ({
              role: "assistant",
              phase: "commentary",
              content: [
                {
                  type: "text",
                  text: `Finding ${index + 1}: ${finding}`,
                },
              ],
              timestamp: now + index + 1,
              __openclaw: { id: "finding-" + index, runId, seq: index + 2 },
            })),
            {
              role: "toolResult",
              toolCallId: "workspace-check",
              toolName: "exec",
              content: [{ type: "text", text: "Workspace check completed" }],
              timestamp: now + 15_000,
              __openclaw: { id: "workspace-check", runId, seq: 15 },
            },
          ];
          const session = {
            key: sessionKey,
            kind: "direct",
            status: "running",
            activeRunIds: [runId],
            hasActiveRun: true,
            updatedAt: now,
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            historyMessages: history,
            inFlightRun: { runId, text: "" },
            sessionInfo: session,
            sessions: [session],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.locator(".chat-reading-indicator").waitFor();
          await waitForChatScrollIdle(page);
          const thread = page.locator(".chat-thread");
          if (mode === "reading") {
            await thread.hover();
            await page.mouse.wheel(0, -300);
            await waitForChatScrollIdle(page);
          }
          // Observe every animation frame, not only the eventual settled position.
          const probe = await watchScroll(thread);
          const { before } = probe;
          const message = {
            role: "user",
            content: "Please also check the shared components.",
            timestamp: now + 20_000,
            __openclaw: {
              id: "collaborator-user",
              idempotencyKey: "collaborator-steer:user",
              seq: 20,
            },
          };
          await gateway.setHistoryMessages([...history, message]);
          const samplesBeforeEvent = await probe.count();
          await gateway.emitGatewayEvent("session.message", {
            sessionKey,
            message,
            messageId: "collaborator-user",
            messageSeq: 20,
            hasActiveRun: true,
            activeRunIds: [runId],
            clientRunId: "collaborator-steer",
            session,
          });
          await page
            .getByText("Please also check the shared components.", { exact: true })
            .waitFor();
          await waitForChatScrollIdle(page);
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: "delta",
            seq: 1,
            message: {
              role: "assistant",
              content: Array.from(
                { length: 25 },
                (_, index) => `Incoming detail ${index + 1}.`,
              ).join("\n\n"),
            },
          });
          await page
            .getByText("Incoming detail 25.", { exact: true })
            .waitFor({ state: "attached" });
          await waitForChatScrollIdle(page);
          const after = await probe.stop();
          const tops = after.samples;
          expect(new Set(after.keys).size).toBe(after.keys.length);
          expect(after.keys[1]).toBe(before.frameKey);
          expect(after.samples.length).toBeGreaterThan(samplesBeforeEvent);
          // Appending a peer turn must not move backwards through existing content.
          for (let index = 1; index < tops.length; index += 1) {
            expect(tops[index]).toBeGreaterThanOrEqual(tops[index - 1]! - 1);
          }
          expect(Math.min(...tops)).toBeGreaterThanOrEqual(before.top - 1);
          if (mode === "following") {
            expect(after.distance).toBeLessThanOrEqual(8);
          } else {
            expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
          }
        },
      );
    },
  );
});
