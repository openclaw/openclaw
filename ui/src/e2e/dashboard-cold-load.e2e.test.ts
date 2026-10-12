import path from "node:path";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Dashboard deep-link first paint" });
const sessionKey = "agent:main:dashboard:12345678-90ab-4def-8234-567890abcdef";
const title = "Mission control";

suite.define(() => {
  const sandbox = useCanvasSandboxFixture();
  it.each(["mission-control-1234567890ab4def8234567890abcdef", "mission-control"])(
    "restores /dashboard/main/%s before hello",
    async (reference) => {
      await suite.withPage(
        {
          viewport: { width: 1440, height: 900 },
          serviceWorkers: "block",
          permissions: ["local-network-access"],
        },
        async ({ page }) => {
          const documentRequested = createDeferred();
          const documentRelease = createDeferred();
          const configRelease = createDeferred();
          let reloading = false;
          let boardRequestedAt = 0;
          const widgetHtml = buildWidgetDocument(title, "<h1>All systems ready</h1>");
          await page.route("**/__openclaw__/board/**", async (route) => {
            if (reloading) {
              boardRequestedAt = performance.now();
              documentRequested.resolve();
              await documentRelease.promise;
            }
            await route.fulfill({ status: 200, contentType: "text/html", body: widgetHtml });
          });
          const row = {
            ...createControlUiSessionRow(sessionKey, title, 1),
            boardFace: "dashboard",
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            authMethod: "trusted-proxy",
            authMode: "trusted-proxy",
            presenceUsers: [{ id: "fixture-operator", self: true, name: "Fixture operator" }],
            heldMethods: ["connect", "board.get"],
            featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
            sessions: [row],
            historyMessages: [{ role: "assistant", content: "Synthetic mission briefing." }],
            methodResponses: {
              "board.get": {
                sessionKey,
                revision: 1,
                tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
                widgets: [
                  {
                    name: "mission",
                    tabId: "main",
                    title,
                    contentKind: "html",
                    sizeW: 12,
                    sizeH: 8,
                    position: 0,
                    grantState: "none",
                    revision: 1,
                    frameUrl: `${new URL(suite.server.baseUrl).origin}/__openclaw__/board/${encodeURIComponent(sessionKey)}/mission/index.html?bt=synthetic-ticket`,
                    viewTicket: "synthetic-ticket",
                    viewTicketTtlMs: 1_200_000,
                    viewGeneration: "0123456789abcdef0123456789abcdef",
                    sandboxUrl: sandbox(widgetHtml).sandboxUrl,
                    sandboxPort: sandbox(widgetHtml).sandboxPort,
                  },
                ],
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          await page.getByText("Synthetic mission briefing.", { exact: true }).waitFor();
          await page.locator(".chat-pane__session-title-text", { hasText: title }).waitFor();
          await gateway.waitForRequest("board.get");
          await gateway.resolveDeferred("board.get");
          await page
            .frameLocator(".board-widget__frame")
            .frameLocator("iframe")
            .getByText("All systems ready")
            .waitFor();
          await selectChatLayoutAction(page, /^Swap /);
          await expect
            .poll(() =>
              page
                .locator("openclaw-board-view")
                .evaluate((view) => view.closest("[data-region]")?.getAttribute("data-region")),
            )
            .toBe("main");
          // Transcript persistence is debounced separately from the sidebar write.
          await expect
            .poll(() =>
              page.evaluate(async (expectedSessionKey) => {
                if (
                  !Object.keys(localStorage).some((key) =>
                    key.startsWith("openclaw.control.bootRecord.v1:"),
                  )
                ) {
                  return false;
                }
                if (
                  !(await indexedDB.databases()).some((db) => db.name === "openclaw-chat-snapshots")
                ) {
                  return false;
                }
                return new Promise<boolean>((resolve, reject) => {
                  const open = indexedDB.open("openclaw-chat-snapshots");
                  open.addEventListener("error", () =>
                    reject(open.error ?? new Error("Boot snapshot open failed")),
                  );
                  open.addEventListener("success", () => {
                    const db = open.result;
                    const transaction = db.transaction(
                      ["sidebarSnapshots", "snapshots"],
                      "readonly",
                    );
                    const request = transaction.objectStore("sidebarSnapshots").count();
                    const snapshots = transaction.objectStore("snapshots").getAll();
                    transaction.addEventListener("complete", () => {
                      db.close();
                      const transcriptPersisted = snapshots.result.some((record: unknown) => {
                        if (
                          typeof record !== "object" ||
                          record === null ||
                          !("sessionKey" in record) ||
                          typeof record.sessionKey !== "string" ||
                          !record.sessionKey.endsWith(`\u0000${expectedSessionKey}`) ||
                          !("snapshot" in record) ||
                          typeof record.snapshot !== "object" ||
                          record.snapshot === null ||
                          !("messages" in record.snapshot) ||
                          !Array.isArray(record.snapshot.messages)
                        ) {
                          return false;
                        }
                        return record.snapshot.messages.some(
                          (message: unknown) =>
                            typeof message === "object" &&
                            message !== null &&
                            "role" in message &&
                            message.role === "assistant" &&
                            "content" in message &&
                            message.content === "Synthetic mission briefing.",
                        );
                      });
                      resolve(request.result > 0 && transcriptPersisted);
                    });
                  });
                });
              }, sessionKey),
            )
            .toBe(true);
          await page.addInitScript(() => {
            const frames: Array<{
              title: string;
              welcome: boolean;
              board: boolean;
              boardRegion: string | null;
              transcript: boolean;
              transcriptRegion: string | null;
            }> = [];
            Reflect.set(window, "dashboardPaints", frames);
            const observe = () => {
              const pane = document.querySelector(".chat-pane-cache__pane--visible");
              const heading = pane?.querySelector(".chat-pane__session-title-text");
              if (heading) {
                const board = pane?.querySelector("[data-panel-skeleton=board]");
                const bounds = board?.getBoundingClientRect();
                const transcript = pane?.querySelector(".chat-thread");
                frames.push({
                  title: heading.textContent?.trim() ?? "",
                  welcome: Boolean(pane?.querySelector(".agent-chat__welcome")),
                  board: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
                  boardRegion: board?.closest("[data-region]")?.getAttribute("data-region") ?? null,
                  transcript:
                    transcript?.textContent?.includes("Synthetic mission briefing.") ?? false,
                  transcriptRegion:
                    transcript?.closest("[data-region]")?.getAttribute("data-region") ?? null,
                });
              }
              if (frames.length < 120) {
                requestAnimationFrame(observe);
              }
            };
            requestAnimationFrame(observe);
          });
          await page.route("**/control-ui-config.json", async (route) => {
            await configRelease.promise;
            await route.fallback();
          });
          reloading = true;
          try {
            await page.goto(`${suite.server.baseUrl}dashboard/main/${reference}`, {
              waitUntil: "domcontentloaded",
            });
            await gateway.waitForRequest("connect");
            const skeleton = page.locator("[data-panel-skeleton=board]");
            await skeleton.waitFor();
            await page.screenshot({ path: path.join(suite.artifactDir, "before-hello.png") });
            expect(
              await page.getByText("Synthetic mission briefing.", { exact: true }).isVisible(),
            ).toBe(true);
            expect(await page.locator("[data-panel-skeleton=chat]").count()).toBe(0);
            const frames = await page.evaluate(() => Reflect.get(window, "dashboardPaints"));
            console.log("Dashboard reload first painted frame", JSON.stringify(frames[0]));
            expect(frames.length).toBeGreaterThan(0);
            expect(frames).toEqual(
              expect.arrayContaining([
                {
                  title,
                  welcome: false,
                  board: true,
                  boardRegion: "main",
                  transcript: true,
                  transcriptRegion: "side",
                },
              ]),
            );
            expect(
              frames.every(
                (frame: {
                  title: string;
                  welcome: boolean;
                  board: boolean;
                  boardRegion: string | null;
                  transcript: boolean;
                  transcriptRegion: string | null;
                }) =>
                  frame.title === title &&
                  !frame.welcome &&
                  frame.board &&
                  frame.boardRegion === "main" &&
                  frame.transcript &&
                  frame.transcriptRegion === "side",
              ),
            ).toBe(true);
            expect(await gateway.getRequests("board.get")).toHaveLength(0);
            const helloReleasedAt = performance.now();
            await gateway.resolveDeferred("connect");
            await gateway.waitForRequest("board.get");
            expect(await skeleton.count()).toBe(1);
            await gateway.resolveDeferred("board.get");
            await documentRequested.promise;
            console.log(
              "Dashboard document request after hello release (ms)",
              boardRequestedAt - helloReleasedAt,
            );
            expect(await skeleton.count()).toBe(1);
            await page.screenshot({ path: path.join(suite.artifactDir, "before-widget.png") });
            documentRelease.resolve();
            await page
              .frameLocator(".board-widget__frame")
              .frameLocator("iframe")
              .getByText("All systems ready")
              .waitFor();
            await skeleton.waitFor({ state: "detached" });
            await page.screenshot({ path: path.join(suite.artifactDir, "widget-ready.png") });
          } finally {
            documentRelease.resolve();
            configRelease.resolve();
          }
        },
      );
    },
  );
});
