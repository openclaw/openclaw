import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import { isChatHistoryState } from "../lib/protocol-validators.generated/history-state.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { board as createBoardSnapshot } from "./chat-layout-fixtures.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Dashboard deep-link first paint" });
const sessionKey = "agent:main:dashboard:12345678-90ab-4def-8234-567890abcdef";
const title = "Mission control";
const otherSessionKey = sessionKey.replace("agent:main:", "agent:other:");

suite.define(() => {
  const sandbox = useCanvasSandboxFixture();
  it.each(["mission-control-1234567890ab4def8234567890abcdef", "mission-control"])(
    "restores /dashboard/main/%s before the socket opens",
    async (reference) => {
      const delayTranscriptValidation =
        reference === "mission-control-1234567890ab4def8234567890abcdef";
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
          let boardDocumentRequests = 0;
          let widgetHtml = buildWidgetDocument(title, "<h1>All systems ready</h1>");
          await page.route("**/__openclaw__/board/**", async (route) => {
            if (reloading) {
              boardDocumentRequests += 1;
              documentRequested.resolve();
              await documentRelease.promise;
            }
            await route.fulfill({ status: 200, contentType: "text/html", body: widgetHtml });
          });
          const row = {
            ...createControlUiSessionRow(sessionKey, title, 1),
            boardFace: "dashboard",
          };
          const board = createBoardSnapshot(sessionKey, [
            createBoardWidget({
              name: "mission",
              title,
              sizeW: 12,
              sizeH: 8,
              frameUrl: `${new URL(suite.server.baseUrl).origin}/__openclaw__/board/${encodeURIComponent(sessionKey)}/mission/index.html?bt=synthetic-ticket`,
              viewTicket: "synthetic-ticket",
              viewTicketTtlMs: 1_200_000,
              viewGeneration: "0123456789abcdef0123456789abcdef",
              sandboxUrl: sandbox(widgetHtml).sandboxUrl,
              sandboxPort: sandbox(widgetHtml).sandboxPort,
            }),
          ]);
          const gateway = await installMockGateway(page, {
            sessionKey,
            authMethod: "trusted-proxy",
            authMode: "trusted-proxy",
            presenceUsers: [{ id: "fixture-operator", self: true, name: "Fixture operator" }],
            heldMethods: ["connect", "board.get"],
            featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
            sessions: [row, { ...row, key: otherSessionKey, label: "Other mission" }],
            historyMessages: [{ role: "assistant", content: "Synthetic mission briefing." }],
            methodResponses: {
              ...(delayTranscriptValidation
                ? {
                    "chat.startup": {
                      sessionId: row.sessionId,
                      sessionInfo: { key: sessionKey, sessionId: row.sessionId, kind: "direct" },
                      messages: [{ role: "assistant", content: "Synthetic mission briefing." }],
                      stateRevision: {
                        sessionInfo: "mission-session-v1",
                        commands: "mission-commands-v1",
                      },
                      metadata: { commands: [], models: [] },
                    },
                  }
                : {}),
              "agents.list": agentRoster({ main: "Main", other: "Other" }, "main", "per-sender"),
              "board.get": board,
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
          const readSnapshots = () =>
            page.evaluate(async () => {
              const boot = Object.keys(localStorage).some((key) =>
                key.startsWith("openclaw.control.bootRecord.v1:"),
              );
              if (
                !(await indexedDB.databases()).some((db) => db.name === "openclaw-chat-snapshots")
              ) {
                return { boot, sidebar: false, snapshots: [] };
              }
              return new Promise<{ boot: boolean; sidebar: boolean; snapshots: unknown[] }>(
                (resolve, reject) => {
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
                    const sidebar = transaction.objectStore("sidebarSnapshots").count();
                    const snapshots: IDBRequest<unknown[]> = transaction
                      .objectStore("snapshots")
                      .getAll();
                    transaction.addEventListener("complete", () => {
                      db.close();
                      resolve({ boot, sidebar: sidebar.result > 0, snapshots: snapshots.result });
                    });
                  });
                },
              );
            });
          // Transcript persistence is debounced separately from the sidebar write.
          const waitForSnapshot = (revision: number) =>
            expect.poll(readSnapshots).toEqual({
              boot: true,
              sidebar: true,
              snapshots: expect.arrayContaining([
                expect.objectContaining({
                  sessionKey: expect.stringMatching(new RegExp(`\u0000${sessionKey}$`)),
                  snapshot: expect.objectContaining({
                    messages: expect.arrayContaining([
                      expect.objectContaining({
                        role: "assistant",
                        content: "Synthetic mission briefing.",
                      }),
                    ]),
                    board: expect.objectContaining({
                      snapshot: expect.objectContaining({ revision }),
                    }),
                    ...(delayTranscriptValidation ? { historyState: expect.any(Object) } : {}),
                  }),
                }),
              ]),
            });
          await waitForSnapshot(1);
          if (delayTranscriptValidation) {
            const record = createRequireRecord("record", "expected-object-value");
            const saved = (await readSnapshots()).snapshots
              .map(record)
              .find(
                (value) =>
                  typeof value.sessionKey === "string" &&
                  value.sessionKey.endsWith(`\u0000${sessionKey}`),
              );
            expect(isChatHistoryState(record(saved?.snapshot).historyState)).toBe(true);
          }
          await page.addInitScript(() => {
            const frames: Array<{
              title: string;
              empty: boolean;
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
                const boardSkeleton = pane?.querySelector("[data-panel-skeleton=board]");
                const bounds = boardSkeleton?.getBoundingClientRect();
                const transcript = pane?.querySelector(".chat-thread");
                frames.push({
                  title: heading.textContent?.trim() ?? "",
                  empty: Boolean(pane?.querySelector(".agent-chat__empty")),
                  board: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
                  boardRegion:
                    boardSkeleton?.closest("[data-region]")?.getAttribute("data-region") ?? null,
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
          const historyValidator = delayTranscriptValidation
            ? await holdModuleResponse(page, /\/assets\/history-state-[^/]+\.js(?:\?.*)?$/u)
            : undefined;
          await gateway.setOnline(false);
          reloading = true;
          try {
            await page.goto(`${suite.server.baseUrl}dashboard/main/${reference}`, {
              waitUntil: "domcontentloaded",
            });
            if (historyValidator) {
              await historyValidator.request;
              historyValidator.release();
              await page.getByText("Synthetic mission briefing.", { exact: true }).waitFor();
            }
            const skeleton = page.locator("[data-panel-skeleton=board]");
            await skeleton.waitFor();
            expect(
              await page.getByText("Synthetic mission briefing.", { exact: true }).isVisible(),
            ).toBe(true);
            expect(await page.locator("[data-panel-skeleton=chat]").count()).toBe(0);
            const frames = await page.evaluate(() => Reflect.get(window, "dashboardPaints"));
            expect(frames.length).toBeGreaterThan(0);
            for (const frame of frames) {
              const { transcript, ...layout } = frame;
              expect(layout).toEqual({
                title,
                empty: false,
                board: true,
                boardRegion: "main",
                transcriptRegion: "side",
              });
              if (!delayTranscriptValidation) {
                expect(transcript).toBe(true);
              }
            }
            expect(await gateway.getRequests("board.get")).toHaveLength(0);
            expect(await gateway.getRequests("connect")).toHaveLength(0);
            await page.locator(".chat-pane__connection-state").waitFor({ state: "visible" });
            const frame = page.locator(".board-widget__frame");
            await frame.waitFor({ state: "attached" });
            const warmFrame = await frame.elementHandle();
            await expect.poll(() => boardDocumentRequests).toBe(1);
            await documentRequested.promise;
            expect(await gateway.getRequests("board.get")).toHaveLength(0);
            expect(await skeleton.count()).toBe(1);
            documentRelease.resolve();
            await page
              .frameLocator(".board-widget__frame")
              .frameLocator("iframe")
              .getByText("All systems ready")
              .waitFor();
            await skeleton.waitFor({ state: "detached" });
            await gateway.setOnline(true);
            await gateway.waitForRequest("connect");
            await gateway.resolveDeferred("connect");
            await gateway.waitForRequest("board.get");
            await gateway.resolveDeferred("board.get");
            await page.locator(".chat-pane__connection-state").waitFor({ state: "hidden" });
            await page.evaluate(
              () =>
                new Promise<void>((resolve) => {
                  requestAnimationFrame(() => resolve());
                }),
            );
            expect(
              await frame.evaluate((current, expected) => current === expected, warmFrame),
            ).toBe(true);
            expect(boardDocumentRequests).toBe(1);
            if (reference === "mission-control") {
              const pendingBoard = {
                ...board,
                revision: 2,
                widgets: [{ ...board.widgets[0]!, revision: 2, grantState: "pending" }],
              };
              const beforePending = await gateway.deferNext("board.get");
              await gateway.emitGatewayEvent("board.changed", { sessionKey });
              await gateway.waitForRequest("board.get", { after: beforePending });
              await gateway.resolveDeferred("board.get", pendingBoard);
              await page.locator('[data-test-id="board-pending"]').waitFor();
              await waitForSnapshot(2);
              const beforePendingReload = boardDocumentRequests;
              await page.reload({ waitUntil: "domcontentloaded" });
              await gateway.waitForRequest("connect");
              await page.locator('[data-test-id="board-pending"]').waitFor();
              expect(await frame.count()).toBe(0);
              expect(boardDocumentRequests).toBe(beforePendingReload);
              expect(await gateway.getRequests("board.get")).toHaveLength(0);

              await page.goto(
                controlUiSessionUrl(suite.server.baseUrl, otherSessionKey, "dashboard"),
                {
                  waitUntil: "domcontentloaded",
                },
              );
              await gateway.waitForRequest("connect");
              await page.locator("[data-panel-skeleton=board]").waitFor();
              expect(await page.locator('[data-test-id="board-pending"]').count()).toBe(0);
              expect(await frame.count()).toBe(0);
              expect(boardDocumentRequests).toBe(beforePendingReload);
            } else {
              const changedBoard = {
                ...board,
                revision: 2,
                widgets: [{ ...board.widgets[0]!, revision: 2 }],
              };
              widgetHtml = buildWidgetDocument(title, "<h1>Updated mission ready</h1>");
              const beforeChanged = await gateway.deferNext("board.get");
              await gateway.emitGatewayEvent("board.changed", { sessionKey });
              await gateway.waitForRequest("board.get", { after: beforeChanged });
              await gateway.resolveDeferred("board.get", changedBoard);
              await page
                .frameLocator(".board-widget__frame")
                .frameLocator("iframe")
                .getByText("Updated mission ready")
                .waitFor();

              const beforeRemoved = await gateway.deferNext("board.get");
              await gateway.emitGatewayEvent("board.changed", { sessionKey });
              await gateway.waitForRequest("board.get", { after: beforeRemoved });
              await gateway.resolveDeferred("board.get", { ...board, revision: 3, widgets: [] });
              await frame.waitFor({ state: "detached" });

              const beforeRestored = await gateway.deferNext("board.get");
              await gateway.emitGatewayEvent("board.changed", { sessionKey });
              await gateway.waitForRequest("board.get", { after: beforeRestored });
              await gateway.resolveDeferred("board.get", changedBoard);
              await page
                .frameLocator(".board-widget__frame")
                .frameLocator("iframe")
                .getByText("Updated mission ready")
                .waitFor();
              const reconnectFrame = await frame.elementHandle();
              const beforeReconnect = await gateway.deferNext("connect");
              const beforeRevalidate = await gateway.deferNext("board.get");
              await gateway.setOnline(false);
              await gateway.setOnline(true);
              await gateway.waitForRequest("connect", { after: beforeReconnect });
              expect(
                await frame.evaluate((current, expected) => current === expected, reconnectFrame),
              ).toBe(true);
              await gateway.resolveDeferred("connect");
              await gateway.waitForRequest("board.get", { after: beforeRevalidate });
              await gateway.rejectDeferred("board.get", {
                code: "FORBIDDEN",
                message: "Dashboard access removed",
              });
              await frame.waitFor({ state: "detached" });
            }
          } finally {
            historyValidator?.release();
            documentRelease.resolve();
            configRelease.resolve();
          }
        },
      );
    },
  );
});
