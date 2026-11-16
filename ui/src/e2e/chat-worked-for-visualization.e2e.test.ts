// Control UI E2E covers completed-work expansion and persistent visual outcomes.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.ts";
import { createNestedToolActivity } from "../../../src/sessions/nested-tool-activity.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";

let artifactDir: string | undefined;
beforeEach(() => {
  const parent = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  artifactDir = parent
    ? createControlUiE2eArtifactDir("chat-worked-for-visualization", parent)
    : undefined;
});
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { waitForChatScrollIdle, chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

declare global {
  interface Window {
    pauseTranscriptResizeObservers: () => void;
    resumeTranscriptResizeObservers: () => void;
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI completed work visualizations",
  startServerBeforeBrowser: true,
});

async function captureProof(page: import("playwright").Page, name: string) {
  if (!artifactDir) {
    return;
  }
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it.each(["saved", "live"] as const)(
    "keeps inspected images in work and delivered media visible (%s)",
    async (source) => {
      await suite.withPage(
        { viewport: { width: 1200, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:tool-media-work";
          const imageUrl = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 120;
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#153343";
            context.fillRect(0, 0, 640, 120);
            context.fillStyle = "#9de2dd";
            context.font = "24px sans-serif";
            context.fillText("Verified preview · synthetic fixture", 30, 70);
            return canvas.toDataURL("image/png");
          });
          const image = {
            type: "image",
            url: imageUrl,
            mimeType: "image/png",
            width: 640,
            height: 120,
          };
          const inspect = (id: string) => [
            {
              role: "assistant",
              stopReason: "toolUse",
              content: [
                { type: "toolCall", id, name: "view_image", arguments: { path: id + ".png" } },
              ],
            },
            {
              role: "toolResult",
              toolCallId: id,
              toolName: "view_image",
              content: [{ type: "text", text: "Inspected screenshot" }, image],
            },
          ];
          const messages = [
            { role: "user", content: "Check the preview and show the final image." },
            { role: "assistant", phase: "commentary", content: "I will inspect both screenshots." },
            ...inspect("before"),
            {
              role: "assistant",
              provider: "openclaw",
              model: "gateway-publication",
              stopReason: "stop",
              content: "Published the preview update.",
            },
            ...inspect("after"),
            {
              role: "assistant",
              phase: "final_answer",
              stopReason: "stop",
              content: [{ type: "text", text: "The preview is ready." }, image],
            },
          ].map((message, index) =>
            Object.assign(message, {
              timestamp: 1_000 + index * 1_000,
              __openclaw: { id: "media-work-" + index, seq: index + 1, runId: "media-work-run" },
            }),
          );
          const runId = "media-work-run";
          const gateway = await installMockGateway(page, {
            sessionKey,
            historyMessages: source === "live" ? messages.slice(0, -1) : messages,
            ...(source === "live"
              ? {
                  inFlightRun: { runId, startedAt: 1_000, text: "" },
                  sessionInfo: { hasActiveRun: true, activeRunIds: [runId] },
                }
              : {}),
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          if (source === "live") {
            await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
            await page.getByText("after.png", { exact: false }).waitFor();
            expect(await page.locator(".chat-work-group").count()).toBe(0);
            const finalMessage = messages.at(-1)!;
            await gateway.setHistoryMessages(messages);
            await gateway.emitGatewayEvent("session.message", {
              sessionKey,
              runId,
              message: finalMessage,
              messageId: finalMessage["__openclaw"].id,
              messageSeq: finalMessage["__openclaw"].seq,
              hasActiveRun: true,
              activeRunIds: [runId],
            });
            await gateway.emitGatewayEvent("chat", {
              sessionKey,
              runId,
              seq: 1,
              state: "final",
              message: finalMessage,
            });
            await gateway.emitGatewayEvent("sessions.changed", {
              sessionKey,
              reason: "lifecycle",
              session: {
                key: sessionKey,
                hasActiveRun: false,
                activeRunIds: [],
                lastRunId: runId,
                status: "done",
              },
            });
          }
          // The saved case reloads the persisted fixture; the live case checks the
          // event-to-history handoff without replacing the page or its transcript.
          for (const reloaded of source === "saved" ? [false, true] : [false]) {
            if (reloaded) {
              await page.reload();
            }
            const answer = page
              .locator(".chat-bubble")
              .getByText("The preview is ready.", { exact: true });
            await answer.waitFor();
            const work = page.locator(".chat-work-group > .chat-activity-group__summary");
            await work.waitFor();
            await waitForChatScrollIdle(page);
            if (!reloaded) {
              await captureProof(page, `tool-media-collapsed-${source}`);
            }
            expect(await work.count()).toBe(1);
            expect(await work.getAttribute("aria-expanded")).toBe("false");
            expect(await page.getByText("before.png", { exact: false }).isVisible()).toBe(false);
            expect(await page.getByText("after.png", { exact: false }).isVisible()).toBe(false);
            expect(await page.locator(".chat-thread img.chat-message-image").count()).toBe(1);
            await work.click();
            await waitForChatScrollIdle(page);
            expect(await work.getAttribute("aria-expanded")).toBe("true");
            await page.getByText("Published the preview update.", { exact: true }).waitFor();
            expect(await page.getByText("before.png", { exact: false }).isVisible()).toBe(true);
            expect(await page.getByText("after.png", { exact: false }).isVisible()).toBe(true);
            expect(await answer.isVisible()).toBe(true);
            await work.click();
            await waitForChatScrollIdle(page);
            expect(await page.locator(".chat-thread img.chat-message-image").count()).toBe(1);
          }
        },
      );
    },
  );
  it.each([
    { scenario: "widget first", browserFirst: false, framed: false },
    { scenario: "browser first", browserFirst: true, framed: false },
    { scenario: "widget first in a run frame", browserFirst: false, framed: true },
  ])(
    "keeps delivered widgets visible without automatic browser previews ($scenario)",
    async ({ browserFirst, framed }) => {
      await suite.withPage(
        { viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:visual-order";
          const viewId = "cv_visual_order";
          const canvasResult = {
            kind: "canvas",
            presentation: { target: "assistant_message", title: "Release confidence" },
            view: { id: viewId, url: `/__openclaw__/canvas/documents/${viewId}/index.html` },
          };
          const browserTab = {
            target: "host",
            profile: "managed",
            targetId: "visual-order-tab",
            title: "Release reference",
            url: "https://example.com/release",
          };
          const nestedExec = (
            id: string,
            toolName: string,
            input: Record<string, unknown>,
            value: unknown,
            timestamp: number,
            details?: Record<string, unknown>,
          ) => {
            const json = JSON.stringify(value);
            const text =
              toolName === "browser"
                ? `<<<EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>\nSource: Browser\n---\n${json}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>`
                : json;
            const result = { content: [{ type: "text", text }], details };
            return [
              {
                role: "assistant",
                content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
                timestamp,
              },
              createNestedToolActivity({
                runId: "visual-order-run",
                scopeId: id,
                afterEntryId: id,
                startOrder: 0,
                parentToolCallId: id,
                toolCallId: `${id}-child`,
                toolName,
                input,
                result,
                isError: false,
                startedAt: timestamp + 100,
                timestamp: timestamp + 200,
              }),
              {
                role: "toolResult",
                toolCallId: id,
                toolName: "exec",
                content: result.content,
                timestamp: timestamp + 300,
              },
            ];
          };
          const widgetMessages = [
            ...nestedExec(
              "widget",
              "show_widget",
              { title: "Release confidence" },
              canvasResult,
              browserFirst ? 3_000 : 2_000,
            ),
            {
              role: "assistant",
              content: `[embed ref="${viewId}" title="Release confidence" height="1000" /]`,
              timestamp: browserFirst ? 4_000 : 3_000,
            },
          ];
          const browserMessages = nestedExec(
            "open",
            "browser",
            { action: "open", targetUrl: browserTab.url },
            browserTab,
            browserFirst ? 2_000 : 4_000,
            { browserTab },
          );
          const history = [
            {
              role: "user",
              content: "Show a widget and check the release page.",
              timestamp: 1_000,
            },
            ...(browserFirst
              ? [...browserMessages, ...widgetMessages]
              : [...widgetMessages, ...browserMessages]),
            ...nestedExec(
              "close",
              "browser",
              { action: "close", targetId: browserTab.targetId },
              { ok: true },
              5_000,
            ),
            {
              role: "assistant",
              content: "The widget and release reference are ready.",
              timestamp: 6_000,
            },
          ];
          await installMockGateway(page, {
            sessionKey,
            methodResponses: {
              "canvas.document.view": canvasView(`<!doctype html>
              <style>body { margin: 0; padding: 24px; background: #132332; color: #eaf5ff; font: 16px system-ui; }
              div { margin-top: 18px; padding: 18px; background: #254c65; border-radius: 8px; }</style>
              <h2>Release confidence</h2><p>First output · inline widget</p>
              <div>Gateway 92% &nbsp; Control UI 84% &nbsp; Mobile 68%</div>`),
            },
            historyMessages: projectChatDisplayMessages(
              history.map((message, index) =>
                framed
                  ? Object.assign(message, {
                      __openclaw: {
                        id: `visual-${index}`,
                        seq: index + 1,
                        runId: "visual-order-run",
                      },
                    })
                  : message,
              ),
            ),
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page
            .getByText("The widget and release reference are ready.", { exact: true })
            .waitFor();
          const widget = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
          const browser = page.locator("openclaw-browser-tab-card");
          await widget.waitFor();
          await waitForChatScrollIdle(page);
          expect(await widget.count()).toBe(1);
          expect(await browser.count()).toBe(0);
          const workedFor = page.locator(".chat-work-group > .chat-activity-group__summary");
          expect(await workedFor.getAttribute("aria-expanded")).toBe("false");
          for (const expanded of [true, false]) {
            await workedFor.click();
            await waitForChatScrollIdle(page);
            expect(await workedFor.getAttribute("aria-expanded")).toBe(String(expanded));
            expect(await widget.count()).toBe(1);
            expect(await browser.count()).toBe(0);
            const overlaps = await page
              .locator(".chat-virtual-row:not([data-prepared-row])")
              .evaluateAll((elements) => {
                const rects = elements.map((element) => element.getBoundingClientRect());
                return rects.flatMap((rect, index) => {
                  const next = rects[index + 1];
                  return next && rect.bottom > next.top
                    ? [{ bottom: rect.bottom, nextTop: next.top }]
                    : [];
                });
              });
            expect(overlaps).toEqual([]);
          }
        },
      );
    },
  );
  it("keeps visual output visible and virtual rows apart when completed work expands", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1200 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:worked-for-geometry";
      await page.addInitScript(() => {
        const NativeResizeObserver = window.ResizeObserver;
        let paused = false;
        Object.defineProperties(window, {
          pauseTranscriptResizeObservers: {
            configurable: true,
            value: () => {
              paused = true;
            },
          },
          resumeTranscriptResizeObservers: {
            configurable: true,
            value: () => {
              paused = false;
            },
          },
        });
        window.ResizeObserver = class PausableResizeObserver extends NativeResizeObserver {
          constructor(callback: ResizeObserverCallback) {
            super((entries, observer) => {
              if (!paused) {
                callback(entries, observer);
              }
            });
          }
        };
      });
      const documentHtml = `<!doctype html>
            <style>
              * { box-sizing: border-box; }
              html, body { margin: 0; min-height: 100%; background: #0d1017; color: #f4f6fa; font: 14px system-ui; }
              figure { margin: 0; padding: 20px 22px; }
              figcaption { margin-bottom: 16px; font-size: 13px; font-weight: 650; letter-spacing: .02em; }
              .row { display: grid; grid-template-columns: 72px 1fr 36px; align-items: center; gap: 10px; margin-top: 11px; }
              .label, .value { color: #b8c0cc; font-size: 12px; }
              .value { text-align: right; font-variant-numeric: tabular-nums; }
              .track { height: 10px; overflow: hidden; border-radius: 4px; background: #252b36; }
              .bar { height: 100%; border-radius: 4px; background: #76b7ff; }
            </style>
            <figure aria-label="Release confidence by platform">
              <figcaption>Release confidence</figcaption>
              <div class="row"><span class="label">Gateway</span><div class="track"><div class="bar" style="width:92%"></div></div><span class="value">92%</span></div>
              <div class="row"><span class="label">Control UI</span><div class="track"><div class="bar" style="width:84%"></div></div><span class="value">84%</span></div>
              <div class="row"><span class="label">Mobile</span><div class="track"><div class="bar" style="width:68%"></div></div><span class="value">68%</span></div>
            </figure>`;
      await installMockGateway(page, {
        sessionKey,
        methodResponses: { "canvas.document.view": canvasView(documentHtml) },
        historyMessages: [
          { role: "user", content: "Check it.", timestamp: 1_000 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Here is the visualization." },
              {
                type: "canvas",
                preview: {
                  kind: "canvas",
                  surface: "assistant_message",
                  render: "url",
                  title: "Release status",
                  viewId: "cv_worked_for_visual",
                  url: "/__openclaw__/canvas/documents/cv_worked_for_visual/index.html",
                  preferredHeight: 180,
                  sandbox: "scripts",
                },
              },
            ],
            timestamp: 1_500,
          },
          chatMessage("assistant", "Checking.", {
            openclawStreamFallback: {
              itemId: "worked-for-checking",
              replacementText: "Checking.",
              source: "segment",
            },
            timestamp: 2_000,
          }),
          {
            role: "toolResult",
            toolCallId: "worked-for-tool",
            toolName: "bash",
            content: "ok",
            timestamp: 3_000,
          },
          chatMessage("assistant", "Done.", { timestamp: 4_000 }),
        ],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText("Done.", { exact: true }).waitFor();
      await page.locator('.chat-tool-card__preview[data-kind="canvas"]').waitFor();
      const workedFor = page.locator(".chat-work-group > .chat-activity-group__summary");
      await workedFor.waitFor();
      await waitForChatScrollIdle(page);
      await captureProof(page, "worked-for-geometry-collapsed");
      // Completed work is one line: its label and a resting chevron, with no rule below.
      expect(
        await workedFor.evaluate((button) => {
          const chevron = button.querySelector(".chat-inline-disclosure__chevron");
          return {
            chevronOpacity: chevron ? getComputedStyle(chevron).opacity : null,
            trailing:
              button.parentElement!.getBoundingClientRect().bottom -
              button.getBoundingClientRect().bottom,
          };
        }),
      ).toEqual({ chevronOpacity: "1", trailing: 0 });

      const geometry = await workedFor.evaluate(async (element) => {
        const owner = element.closest("openclaw-chat-pane") as
          | (HTMLElement & { updateComplete: Promise<unknown> })
          | null;
        const thread = element.closest<HTMLElement>(".chat-thread");
        if (!owner || !thread) {
          throw new Error("Worked-for disclosure is missing its chat pane or thread");
        }

        window.pauseTranscriptResizeObservers();
        (element as HTMLButtonElement).click();
        await owner.updateComplete;

        const viewport = thread.getBoundingClientRect();
        const rows = Array.from(thread.querySelectorAll<HTMLElement>(".chat-virtual-row"))
          .map((row) => {
            const rect = row.getBoundingClientRect();
            return { key: row.dataset.virtualRowKey, top: rect.top, bottom: rect.bottom };
          })
          .filter((row) => row.bottom > viewport.top && row.top < viewport.bottom);
        const overlaps = rows.flatMap((row, index) => {
          const next = rows[index + 1];
          return next && row.bottom > next.top ? [{ row, next }] : [];
        });

        return { expanded: element.getAttribute("aria-expanded"), rows, overlaps };
      });

      await captureProof(page, "worked-for-geometry-expanded");
      expect(geometry.expanded).toBe("true");
      expect(geometry.rows.length).toBeGreaterThanOrEqual(3);
      expect(geometry.overlaps).toEqual([]);

      await page.evaluate(() => window.resumeTranscriptResizeObservers());
      await workedFor.click();
      await workedFor.click();
      await waitForChatScrollIdle(page);
      await captureProof(page, "worked-for-geometry-settled");
    });
  });
});
