import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat scroll through settled tool rows" });
const prose = [
  "The current implementation reads the saved state, checks the requested operation, and returns the result to the caller.",
  "A restart should preserve the work that has already completed. The next operation can then continue from the recorded position.",
  "The command completed successfully. The remaining question is whether the visible result matches the original request.",
];

/** A long session of settled tool calls, whose rows are estimated far taller than they render. */
function history() {
  const messages: Record<string, unknown>[] = [];
  const add = (message: Record<string, unknown>) =>
    messages.push({ ...message, timestamp: 1794500000000 + messages.length * 1000 });
  for (let turn = 1; turn <= 140; turn++) {
    const runId = `run-${turn}`;
    add({
      role: "user",
      content: [{ type: "text", text: `Question ${turn}: what did you find?` }],
    });
    const calls = turn % 2 ? 0 : turn % 11 === 0 ? 18 : turn % 5 === 0 ? 4 : 1;
    for (let call = 0; call < calls; call++) {
      const id = `call-${turn}-${call}`;
      add({
        role: "assistant",
        content: [
          { type: "text", text: `I'll inspect saved file ${call + 1} for step ${turn}.` },
          {
            type: "toolCall",
            id,
            name: "read",
            arguments: { path: `notes/step-${turn}-${call}.md` },
          },
        ],
        stopReason: "toolUse",
        __openclaw: { runId },
      });
      add({
        role: "toolResult",
        content: [{ type: "text", text: `# Notes ${turn}.${call}\n${prose.join("\n")}` }],
        toolCallId: id,
        toolName: "read",
        isError: false,
        __openclaw: { runId },
      });
    }
    add({
      role: "assistant",
      content: [
        { type: "text", text: `Answer ${turn}: ${prose[turn % 3]}\n\n${prose[(turn + 1) % 3]}` },
      ],
      stopReason: "stop",
      __openclaw: { runId },
    });
  }
  return messages;
}

type Sample = Record<string, number>;

suite.define(() => {
  it("never moves visible text against a fast upward scroll", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { historyMessages: history() });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByText("Answer 140:", { exact: false }).waitFor();
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      await page.waitForTimeout(1500);
      // Record what each frame paints: the tops of the rows in view, read after the paint.
      await thread.evaluate((element) => {
        const state = { active: true, samples: [] as Sample[] };
        (window as unknown as { scrollSamples: typeof state }).scrollSamples = state;
        const channel = new MessageChannel();
        channel.port1.addEventListener("message", () => {
          const view = element.getBoundingClientRect();
          const rows: Sample = {};
          for (const row of element.querySelectorAll<HTMLElement>(
            ".chat-virtual-row:not([data-prepared-row])",
          )) {
            const rect = row.getBoundingClientRect();
            if (rect.height > 0 && rect.top >= view.top && rect.bottom <= view.bottom) {
              rows[row.dataset.virtualRowKey!] = rect.top;
            }
          }
          state.samples.push(rows);
          if (state.active) {
            requestAnimationFrame(() => channel.port2.postMessage(0));
          }
        });
        channel.port1.start();
        requestAnimationFrame(() => channel.port2.postMessage(0));
      });
      await thread.hover({ position: { x: 400, y: 250 } });
      // Stay clear of the transcript start, where native scrolling clamps corrections.
      for (let step = 0; step < 50; step++) {
        await page.mouse.wheel(0, -1100);
        await page.waitForTimeout(55);
      }
      await page.waitForTimeout(750);
      const result = await page.evaluate(() => {
        const state = (
          window as unknown as { scrollSamples: { active: boolean; samples: Sample[] } }
        ).scrollSamples;
        state.active = false;
        let against = 0;
        for (let index = 1; index < state.samples.length; index++) {
          const before = state.samples[index - 1]!;
          const after = state.samples[index]!;
          const moves = Object.keys(before)
            .filter((key) => key in after)
            .map((key) => after[key]! - before[key]!)
            .toSorted((left, right) => left - right);
          // Scrolling up moves content down; rows moving up jumped against the scroll.
          const median = moves[Math.floor(moves.length / 2)];
          if (median !== undefined) {
            against = Math.max(against, -median);
          }
        }
        return { against, frames: state.samples.length };
      });
      expect(result.frames).toBeGreaterThan(30);
      expect(result.against).toBeLessThan(2);
    });
  });
});
