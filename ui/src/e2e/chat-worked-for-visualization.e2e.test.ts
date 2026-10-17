import { expect, it } from "vitest";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.ts";
import { createNestedToolActivity } from "../../../src/sessions/nested-tool-activity.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

declare global {
  interface Window {
    transcriptResizeObserversPaused: boolean;
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI completed work visualizations",
  startServerBeforeBrowser: true,
});
const visualHtml = `<!doctype html><style>
  body{margin:0;font:14px system-ui;background:#132332;color:#eaf5ff}
  figure{box-sizing:border-box;height:180px;margin:0;padding:24px}
</style><figure aria-label="Release confidence by platform">Release confidence · synthetic visual output</figure>`;

const chatMessage = <T>(role: string, content: T, timestamp: number) => ({
  role,
  content,
  timestamp,
});

function nestedExec(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  value: unknown,
  timestamp: number,
  details?: Record<string, unknown>,
) {
  const json = JSON.stringify(value);
  const text =
    toolName === "browser"
      ? `<<<EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>\nSource: Browser\n---\n${json}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>`
      : json;
  const result = { content: [{ type: "text", text }], details };
  return [
    chatMessage("assistant", [{ type: "toolCall", id, name: "exec", arguments: {} }], timestamp),
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
      ...chatMessage("toolResult", result.content, timestamp + 300),
      toolCallId: id,
      toolName: "exec",
    },
  ];
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it.each([
    { scenario: "widget first", browserFirst: false, framed: false },
    { scenario: "browser first", browserFirst: true, framed: false },
    { scenario: "widget first in a run frame", browserFirst: false, framed: true },
  ])(
    "keeps widgets and browser previews in execution order ($scenario)",
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
          const widgetMessages = [
            ...nestedExec(
              "widget",
              "show_widget",
              { title: "Release confidence" },
              canvasResult,
              browserFirst ? 3_000 : 2_000,
            ),
            chatMessage(
              "assistant",
              `[embed ref="${viewId}" title="Release confidence" height="1000" /]`,
              browserFirst ? 4_000 : 3_000,
            ),
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
            chatMessage("user", "Show a widget and check the release page.", 1_000),
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
            chatMessage("assistant", "Ready.", 6_000),
          ];
          await installMockGateway(page, {
            sessionKey,
            methodResponses: {
              "canvas.document.view": canvasView(visualHtml),
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
          await page.getByText("Ready.", { exact: true }).waitFor();
          const widget = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
          const browser = page.locator("openclaw-browser-tab-card");
          const expectOutputs = async () => {
            const outputs = await page
              .locator('.chat-tool-card__preview[data-kind="canvas"], openclaw-browser-tab-card')
              .evaluateAll((elements) =>
                elements.map((element) =>
                  element.tagName === "OPENCLAW-BROWSER-TAB-CARD" ? "browser" : "widget",
                ),
              );
            expect(outputs).toEqual(browserFirst ? ["browser", "widget"] : ["widget", "browser"]);
          };
          await widget.waitFor();
          await browser.waitFor();
          await waitForChatScrollIdle(page);
          await expectOutputs();
          const workedFor = page.locator(".chat-work-group > .chat-activity-group__summary");
          expect(await workedFor.getAttribute("aria-expanded")).toBe("false");
          for (const expanded of [true, false]) {
            await workedFor.click();
            await waitForChatScrollIdle(page);
            expect(await workedFor.getAttribute("aria-expanded")).toBe(String(expanded));
            await expectOutputs();
            const overlaps = await page.locator(".chat-virtual-row").evaluateAll((elements) => {
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
        window.transcriptResizeObserversPaused = false;
        window.ResizeObserver = class extends window.ResizeObserver {
          constructor(callback: ResizeObserverCallback) {
            super((entries, observer) => {
              if (!window.transcriptResizeObserversPaused) {
                callback(entries, observer);
              }
            });
          }
        };
      });
      await installMockGateway(page, {
        sessionKey,
        methodResponses: { "canvas.document.view": canvasView(visualHtml) },
        historyMessages: [
          chatMessage("user", "Check it.", 1_000),
          chatMessage(
            "assistant",
            [
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
            1_500,
          ),
          {
            ...chatMessage("assistant", [{ type: "text", text: "Checking." }], 2_000),
            openclawStreamFallback: {
              itemId: "worked-for-checking",
              replacementText: "Checking.",
              source: "segment",
            },
          },
          {
            ...chatMessage("toolResult", "ok", 3_000),
            toolCallId: "worked-for-tool",
            toolName: "bash",
          },
          chatMessage("assistant", [{ type: "text", text: "Done." }], 4_000),
        ],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText("Done.", { exact: true }).waitFor();
      await page.locator('.chat-tool-card__preview[data-kind="canvas"]').waitFor();
      const workedFor = page.locator(".chat-work-group > .chat-activity-group__summary");
      await workedFor.waitFor();
      await waitForChatScrollIdle(page);

      const geometry = await workedFor.evaluate(async (element) => {
        const owner = element.closest("openclaw-chat-pane") as
          | (HTMLElement & { updateComplete: Promise<unknown> })
          | null;
        const thread = element.closest<HTMLElement>(".chat-thread");
        if (!owner || !thread) {
          throw new Error("Worked-for disclosure is missing its chat pane or thread");
        }

        window.transcriptResizeObserversPaused = true;
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

      expect(geometry).toMatchObject({ expanded: "true", overlaps: [] });
      expect(geometry.rows.length).toBeGreaterThanOrEqual(3);
    });
  });
});
