import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Cold transcript viewport resize",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps retained text aligned when a taller cold viewport admits earlier rows", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const historyMessages = Array.from({ length: 40 }, (_, index) => [
          {
            role: "user",
            content: "Prompt " + index + ": preserve this reading position.",
            timestamp: index * 4 + 1,
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "cold-read-" + index,
                name: "read",
                arguments: { path: "synthetic.txt" },
              },
            ],
            timestamp: index * 4 + 2,
          },
          {
            role: "toolResult",
            toolCallId: "cold-read-" + index,
            toolName: "read",
            content: [{ type: "text", text: "Synthetic result." }],
            timestamp: index * 4 + 3,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Response " + index + ": visible retained text." }],
            timestamp: index * 4 + 4,
          },
        ]).flat();
        await installMockGateway(page, { historyMessages });
        await page.goto(suite.server.baseUrl + "chat");
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.locator(".chat-virtual-row").first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await waitForChatScrollIdle(page);
        await expect
          .poll(() =>
            thread.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(2);

        // Observe actual DOM geometry; do not drive the virtualizer or its measurement owner.
        const probe = await thread.evaluateHandle((element) => {
          const rows = Array.from(
            element.querySelectorAll<HTMLElement>(".chat-virtual-row:not([data-prepared-row])"),
          );
          const retained = rows[Math.floor(rows.length / 2)];
          const first = rows[0];
          if (!retained || !first) {
            throw new Error("Expected a laid-out transcript window");
          }
          const firstIndex = Number(first.dataset.index);
          const read = () => ({
            viewportHeight: element.clientHeight,
            scrollTop: element.scrollTop,
            retained: retained.isConnected,
            bottomOffset:
              retained.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
            predecessors: Array.from(element.querySelectorAll<HTMLElement>(".chat-virtual-row"))
              .filter((row) => Number(row.dataset.index) < firstIndex)
              .map((row) => ({
                index: Number(row.dataset.index),
                prepared: row.dataset.preparedRow === "true",
                height: row.getBoundingClientRect().height,
              })),
          });
          const initial = read();
          const inputs: string[] = [];
          const listeners = new AbortController();
          for (const type of ["wheel", "touchstart", "keydown"]) {
            window.addEventListener(type, () => inputs.push(type), {
              capture: true,
              passive: true,
              signal: listeners.signal,
            });
          }
          let frame: number;
          const frames: ReturnType<typeof read>[] = [];
          const finished = new Promise<ReturnType<typeof read>[]>((resolve) => {
            const sample = () => {
              const observed = read();
              // Start the observation budget at the resize, not at a remote action deadline.
              if (observed.viewportHeight > initial.viewportHeight) {
                frames.push(observed);
              }
              if (frames.length === 32) {
                resolve(frames);
              } else {
                frame = requestAnimationFrame(sample);
              }
            };
            frame = requestAnimationFrame(sample);
          });
          return {
            initial,
            inputs,
            finished,
            dispose() {
              cancelAnimationFrame(frame);
              listeners.abort();
            },
          };
        });
        try {
          const initial = await probe.evaluate((value) => value.initial);
          // A native window resize exposes predecessors without a first reader gesture.
          await page.setViewportSize({ width: 1200, height: 1000 });
          const frames = await probe.evaluate((value) => value.finished);
          const inputs = await probe.evaluate((value) => value.inputs);
          const resized = frames.filter((frame) => frame.viewportHeight > initial.viewportHeight);
          const errors = resized.map((frame) =>
            Math.abs(frame.bottomOffset - initial.bottomOffset),
          );
          const artifactParent = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
          if (artifactParent) {
            const directory = createControlUiE2eArtifactDir(
              "cold-resize-admission",
              artifactParent,
            );
            await fs.writeFile(
              path.join(directory, "positions.json"),
              JSON.stringify({ initial, frames, inputs, errors }, null, 2),
            );
            console.log(
              "Cold resize position trace:",
              directory,
              "maximum error:",
              Math.max(...errors),
            );
          }
          expect(inputs).toEqual([]);
          expect(resized.length).toBeGreaterThan(0);
          expect(resized.every((frame) => frame.retained)).toBe(true);
          expect(resized.some((frame) => frame.predecessors.some((row) => !row.prepared))).toBe(
            true,
          );
          expect(Math.max(...errors)).toBeLessThanOrEqual(2);
        } finally {
          await probe.evaluate((value) => value.dispose());
          await probe.dispose();
        }
      },
    );
  });
});
