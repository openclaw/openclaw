import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat scroll through settled tool rows" });
const topics = [
  "Review the command output and explain the next step.",
  "Can you compare the two approaches?",
  "Walk through this change in plain language.",
  "Show the relevant files and what you found.",
  "What should we check before continuing?",
];
const prose = [
  "The current implementation reads the saved state, checks the requested operation, and returns the result to the caller.",
  "A restart should preserve the work that has already completed. The next operation can then continue from the recorded position.",
  "The command completed successfully. The remaining question is whether the visible result matches the original request.",
  "The output shows three independent stages: loading the configuration, preparing the workspace, and running the selected action.",
];

/**
 * A long agent session: prose, tables and code between runs of settled tool calls, whose rows
 * are estimated far taller than they render.
 */
function history() {
  const messages: Record<string, unknown>[] = [];
  const add = (role: string, content: unknown[], extra: Record<string, unknown> = {}) =>
    messages.push({ role, content, timestamp: 1794500000000 + messages.length * 1000, ...extra });
  const text = (value: string) => ({ type: "text", text: value });
  for (let turn = 0; turn < 280; turn++) {
    const step = turn + 1;
    const runId = `run-${step}`;
    const long = turn % 9 === 0 ? `\n\n${prose[1]!.repeat(4)}` : "";
    add("user", [text(`Question ${step}: ${topics[turn % topics.length]}${long}`)]);
    const calls = turn % 2 ? 0 : turn % 11 === 0 ? 18 : turn % 5 === 0 ? 4 : 1;
    for (let call = 0; call < calls; call++) {
      const id = `call-${step}-${call}`;
      const read = call % 4 !== 0;
      add(
        "assistant",
        [
          text(`I'll inspect saved file ${call + 1} for step ${step}.`),
          {
            type: "toolCall",
            id,
            name: read ? "read" : "exec",
            arguments: read
              ? { path: `notes/step-${step}-${call}.md` }
              : { command: `printf 'step ${step} check ${call + 1} complete'` },
          },
        ],
        { stopReason: "toolUse", __openclaw: { runId } },
      );
      const lines = Array.from(
        { length: 8 + ((turn + call) % 20) },
        (_, line) => `Line ${line + 1}: ${prose[line % 4]}`,
      );
      add(
        "toolResult",
        [
          text(
            read
              ? `# Notes for step ${step} check ${call + 1}\n${lines.join("\n")}`
              : `step ${step} check ${call + 1} complete\nchecked ${2 + (turn % 7)} files\nexit 0`,
          ),
        ],
        { toolCallId: id, toolName: read ? "read" : "exec", isError: false, __openclaw: { runId } },
      );
    }
    let answer = `Answer ${step}: ${prose[turn % 4]}\n\n`;
    if (turn % 6 === 0) {
      answer += "| Stage | Result |\n|---|---|\n| Read | Completed |\n| Check | Passed |\n\n";
    }
    if (turn % 5 === 0) {
      answer +=
        "```ts\nconst result = await readSavedState();\nawait continueWork(result);\n```\n\n";
    }
    answer += Array.from({ length: 1 + (turn % 7) }, (_, part) =>
      part % 2
        ? `- ${prose[(turn + part) % 4]}\n- ${prose[(turn + part + 1) % 4]}`
        : prose[(turn + part) % 4]!.repeat(1 + ((turn + part) % 3)),
    ).join("\n\n");
    add("assistant", [text(answer)], { stopReason: "stop", __openclaw: { runId } });
  }
  return messages;
}

type Sample = { top: number; blocks: Record<string, number> };

suite.define(() => {
  it("never moves visible text against an upward scroll", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { historyMessages: history() });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByText("Answer 280:", { exact: false }).waitFor();
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      await page.waitForTimeout(1500);
      // Record what each frame paints: every text block the reader can see, including the one
      // the top edge cuts and rows painted at their slot outside the flow.
      await thread.evaluate((element) => {
        const ids = new WeakMap<Element, string>();
        const state = { active: true, samples: [] as Sample[] };
        (window as unknown as { scrollSamples: typeof state }).scrollSamples = state;
        const channel = new MessageChannel();
        channel.port1.addEventListener("message", () => {
          const view = element.getBoundingClientRect();
          const blocks: Record<string, number> = {};
          for (const row of element.querySelectorAll<HTMLElement>(".chat-virtual-row")) {
            const style = getComputedStyle(row);
            if (style.opacity === "0") {
              continue;
            }
            const box = row.getBoundingClientRect();
            const clipped = style.clip.startsWith("rect");
            const bottom = clipped ? box.top + Number(row.dataset.rowSize) : box.bottom;
            const selector = "p, li, pre, tr, h1, h2, h3, h4, .chat-tool-row";
            for (const block of row.querySelectorAll(selector)) {
              const rect = block.getBoundingClientRect();
              const visible =
                rect.height > 0 &&
                rect.bottom > Math.max(view.top, box.top) &&
                rect.top < Math.min(view.bottom, bottom);
              if (visible) {
                let id = ids.get(block);
                if (!id) {
                  id = String(Math.random());
                  ids.set(block, id);
                }
                blocks[id] = rect.top;
              }
            }
          }
          state.samples.push({ top: element.scrollTop, blocks });
          if (state.active) {
            requestAnimationFrame(() => channel.port2.postMessage(0));
          }
        });
        channel.port1.start();
        requestAnimationFrame(() => channel.port2.postMessage(0));
      });
      await thread.hover({ position: { x: 400, y: 250 } });
      // Read slowly up from the end, then fast. Native scrolling clamps corrections at the
      // transcript start, so the sweep stops well before it.
      for (const [delta, steps] of [
        [-180, 100],
        [-1100, 100],
      ] as const) {
        for (let step = 0; step < steps; step++) {
          if ((await thread.evaluate((element) => element.scrollTop)) < 5000) {
            break;
          }
          await page.mouse.wheel(0, delta);
          await page.waitForTimeout(55);
        }
      }
      await page.waitForTimeout(750);
      const result = await page.evaluate(() => {
        const state = (
          window as unknown as { scrollSamples: { active: boolean; samples: Sample[] } }
        ).scrollSamples;
        state.active = false;
        let against = 0;
        for (let index = 1; index < state.samples.length; index++) {
          const before = state.samples[index - 1]!.blocks;
          const after = state.samples[index]!.blocks;
          for (const key of Object.keys(before)) {
            // Scrolling up moves content down; text moving up jumped against the scroll.
            if (key in after) {
              against = Math.max(against, before[key]! - after[key]!);
            }
          }
        }
        return {
          against,
          frames: state.samples.length,
          lowest: Math.min(...state.samples.map((sample) => sample.top)),
        };
      });
      expect(result.frames).toBeGreaterThan(60);
      expect(result.lowest).toBeGreaterThan(0);
      expect(result.against).toBeLessThan(2);
    });
  });
});
