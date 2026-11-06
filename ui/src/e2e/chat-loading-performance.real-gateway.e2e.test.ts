import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, loadavg, platform, totalmem } from "node:os";
import path from "node:path";
import { gatewayCredentialScope, gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { persistColdLoadWarmState } from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import { startEngineMeasurement } from "../../../scripts/lib/control-ui-engine-metrics.ts";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { recordControlUiE2eFailureFacts } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { installHistoryPaginationProbe } from "./chat-history-pagination-probe.test-support.ts";
import {
  createHistoryAdmissionRecorder,
  detectNonInputHistoryShift,
  holdHistoryPacketEntry,
  installHistoryResponseGate,
  sampleControlledHistoryAdmission,
} from "./chat-history-response-gate.test-support.ts";
import {
  homeKey,
  observeChatLoadingRpc,
  prepareChatLoadingScenario,
  type RpcMetric,
  selectedKey,
  selectRpc,
  selectStartupHistory,
  redactFixtureTokens,
  transcriptLength,
  viewport,
} from "./chat-loading-performance.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance | undefined;
let config: OpenClawConfig;
const suite = createControlUiE2eSuite({
  name: "Control UI chat loading performance with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "chat-loading-performance",
      // Avatar updates wait for the config-reload owner's application receipt.
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
    });
    instance = owner;
    try {
      const workspace = owner.state.path("workspace");
      await mkdir(workspace, { recursive: true });
      const avatar = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      await writeFile(path.join(workspace, "avatar.png"), avatar);
      config = {
        agents: {
          defaults: { workspace },
          entries: {
            main: {
              workspace,
              identity: { name: "Synthetic loading assistant", avatar: "avatar.png" },
            },
          },
        },
        gateway: {
          port: owner.port,
          auth: { mode: "token", token: owner.gatewayToken },
          controlUi: { enabled: true },
        },
      };
      await owner.state.writeConfig(config);
      // Seed the shared-secret owner before setup clients or the browser could
      // adopt this machine's account name.
      ensureGatewayOwnerProfile("Synthetic Viewer", { env: owner.env });
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      const diagnosticPath = path.join(suite.artifactDir, "gateway-setup.log");
      const diagnostic = redactFixtureTokens(
        `${error instanceof Error ? error.message : String(error)}\n${owner.logs()}`,
        owner,
      );
      const failure = new Error(
        `Gateway fixture setup failed; sanitized diagnostics: ${diagnosticPath}`,
      );
      await runQaGatewayFixture(
        async () => {
          await writeFile(diagnosticPath, diagnostic);
          throw failure;
        },
        () => owner.cleanup(),
      );
      throw failure;
    }
  },
});

type LoadingPane = HTMLElement & {
  sessionKey: string;
  transcriptLoading: boolean;
  updateComplete: Promise<boolean>;
  state: {
    chatMessages: unknown[];
    chatHistoryPagination: { hasMore: boolean; hasNewer?: boolean };
  };
  loadingOlder: boolean;
  historyIntentTimer: number | null;
};
suite.define(() => {
  for (const mode of ["hold-free", "controlled geometry"] as const) {
    it(`loads the selected tail before restored Home and caches shared avatar bytes (${mode})`, async (test) => {
      const url = await prepareChatLoadingScenario(test, suite, instance, config);
      const rpc: RpcMetric[] = [];
      const olderHistoryRequests = (metrics: readonly RpcMetric[]) =>
        selectRpc(metrics, "chat.history", selectedKey).filter(
          (metric) =>
            metric.cursor !== undefined &&
            metric.historyKind !== "delta" &&
            metric.historyKind !== "reset",
        );
      const clock = { measuring: false, startedAt: 0 };
      await suite.withPage(
        {
          viewport,
          serviceWorkers: "block",
          locale: "en-US",
        },
        async ({ page }) => {
          const responseGate =
            mode === "controlled geometry"
              ? await installHistoryResponseGate(page, selectedKey)
              : undefined;
          await page.addInitScript(() => {
            // Measure short-link resolution, not cached-roster route recovery. Keep
            // restored Home preferences; clear identity admission in each new document
            // because the previous document can persist its boot record on pagehide.
            if (sessionStorage.getItem("loading-proof-warm-reload") !== "true") {
              for (const key of Object.keys(localStorage)) {
                if (key.startsWith("openclaw.control.bootRecord.v1:")) {
                  localStorage.removeItem(key);
                }
              }
            }
            window.localStorage.setItem(
              "openclaw:control-ui:community-invite:v2",
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            );
          });
          const waitForStartupResponses = () =>
            expect
              .poll(() => {
                const metrics = rpc;
                return (
                  metrics.some(
                    (metric) =>
                      metric.method === "sessions.resolve" && metric.receivedMs !== undefined,
                  ) &&
                  metrics
                    .filter((metric) =>
                      ["agents.list", "agent.identity.get"].includes(metric.method),
                    )
                    .every((metric) => metric.receivedMs !== undefined)
                );
              })
              .toBe(true);
          const waitForStartupCommit = async (sessionKey: string, pane: Locator, after = 0) => {
            await expect
              .poll(() =>
                selectStartupHistory(rpc.slice(after), sessionKey).some(
                  (metric) => metric.receivedMs !== undefined && metric.historyOk === true,
                ),
              )
              .toBe(true);
            await expect
              .poll(() => pane.evaluate((element) => (element as LoadingPane).transcriptLoading))
              .toBe(false);
            await pane.evaluate(async (element) => {
              await (element as LoadingPane).updateComplete;
            });
          };
          const pending = observeChatLoadingRpc(page, rpc, clock);
          await page.goto(url.toString());
          await enterControlUiSession(page);
          await waitForControlUiGatewayReady(page);
          const selectedPane = page.locator(
            "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
          );
          await expect
            .poll(() => selectedPane.evaluate((element) => (element as LoadingPane).sessionKey))
            .toBe(selectedKey);
          const waitForTail = () =>
            selectedPane
              .locator(".chat-thread", {
                hasText: "Synthetic loading proof message 900.",
              })
              .waitFor();
          const composer = selectedPane.locator(".agent-chat__composer-combobox textarea");
          const home = page.locator("openclaw-assistant-panel");
          const waitForHome = () =>
            home
              .locator(".chat-thread")
              .getByText("Synthetic Home message 900.", { exact: false })
              .waitFor();
          const measureLoad = async () => {
            const selectedCommitted = waitForStartupCommit(selectedKey, selectedPane);
            const homeCommitted = waitForStartupCommit(homeKey, home.locator("openclaw-chat-pane"));
            await waitForTail();
            await composer.waitFor();
            await waitForHome();
            await Promise.all([selectedCommitted, homeCommitted]);
          };
          await waitForTail();
          await composer.waitFor();
          await page.locator(".sidebar-footer-bar__home").click();
          await waitForHome();

          clock.startedAt = Date.now();
          clock.measuring = true;
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await measureLoad();
          await page.waitForFunction(() =>
            [
              ...document.querySelectorAll<HTMLImageElement>(".sidebar-agent-card__avatar img"),
            ].some((image) => image.complete && image.naturalWidth > 0),
          );
          // Transcript and roster avatars can render before the dedicated identity reply.
          // Freeze only completed payloads; keep the earlier visibility timings unchanged.
          await waitForStartupResponses();
          const startupMetrics = structuredClone(rpc);
          await writeFile(
            path.join(suite.artifactDir, "startup-rpc.json"),
            JSON.stringify(startupMetrics, null, 2),
          );
          const images = await page
            .locator(".sidebar-agent-card__avatar img")
            .evaluateAll((elements) =>
              elements.map((element) => {
                const image = element as HTMLImageElement;
                return { width: image.naturalWidth, height: image.naturalHeight };
              }),
            );
          const avatarRequests = await page.evaluate(
            () =>
              performance
                .getEntriesByType("resource")
                .filter((entry) => new URL(entry.name).pathname === "/avatar/main").length,
          );

          const thread = selectedPane.locator(".chat-thread");
          const loadedMessageCount = () =>
            selectedPane.evaluate((element) => (element as LoadingPane).state.chatMessages.length);
          // Prefetched pages can commit before the preceding wheel gesture settles.
          const waitForHistoryGesture = () =>
            expect
              .poll(() =>
                selectedPane.evaluate((element) => {
                  const pane = element as LoadingPane;
                  return {
                    loadingOlder: pane.loadingOlder,
                    historyIntentConsumed: pane.historyIntentTimer !== null,
                  };
                }),
              )
              .toEqual({ loadingOlder: false, historyIntentConsumed: false });
          await thread.hover();
          const residentNumbers = () =>
            selectedPane.evaluate((element) =>
              (element as LoadingPane).state.chatMessages.map((message) =>
                Number(
                  JSON.stringify(message).match(/Synthetic loading proof message (\d+)\./u)?.[1],
                ),
              ),
            );
          const initialLoadedMessages = await loadedMessageCount();
          await installHistoryPaginationProbe(selectedPane, initialLoadedMessages + 1, selectedKey);
          const paginationSample = page.evaluate(async () => {
            await window.historyPaginationProbe.done;
            return window.historyPaginationProbe.result();
          });
          const engine = await startEngineMeasurement(page, "chromium", { trace: false });
          const traversalStarted = performance.now();
          const windows: Array<{
            direction: string;
            first: number;
            last: number;
            entries: number;
            jsonUnits: number;
          }> = [];
          const anchors: Array<{
            direction: string;
            source: number;
            residentEdge: number;
            frames: number;
            maxDrift: number;
            positions: Array<number | null>;
            readerMotion: number;
          }> = [];
          let negativeCalibration:
            | Awaited<ReturnType<typeof detectNonInputHistoryShift>>
            | undefined;
          const watchAnchor = async (direction: string, residentEdge: number) => {
            const { source, bubble, finish, cancel } = await sampleControlledHistoryAdmission(
              page,
              thread,
              {
                direction,
                residentEdge,
                readResident: residentNumbers,
                readerCalibration: anchors.length === 0,
              },
            );
            const finishAnchor = async () => {
              const sample = await finish();
              anchors.push({
                direction,
                source,
                residentEdge,
                ...sample,
              });
              if (!negativeCalibration) {
                negativeCalibration = await detectNonInputHistoryShift(page, bubble);
              }
              await writeFile(
                path.join(suite.artifactDir, "controlled-geometry.json"),
                JSON.stringify({
                  anchors,
                  negativeCalibration,
                  releasedResponses: responseGate?.released,
                }),
              );
              expect(
                sample.maxDrift,
                `${direction} source ${source} stays mounted in every frame`,
              ).toBeLessThanOrEqual(2);
            };
            return { finish: finishAnchor, cancel };
          };
          const historyGesture = async (
            direction: "older" | "newer",
            before: number,
            gesture: () => Promise<void>,
          ) => {
            if (!responseGate) {
              await gesture();
              return;
            }
            const entry = await holdHistoryPacketEntry(selectedPane, direction);
            let anchor: Awaited<ReturnType<typeof watchAnchor>> | undefined;
            let completed = false;
            try {
              await gesture();
              await entry.wait();
              const firstCalibration = anchors.length === 0;
              if (firstCalibration) {
                const cursor = await entry.coldCursor();
                await responseGate.waitForColdReply(cursor, entry.release);
              }
              anchor = await watchAnchor(direction, before);
              await entry.assertCurrent();
              if (!firstCalibration) {
                await entry.release();
              }
              await responseGate.releaseAdmission(async () => {
                const resident = await residentNumbers();
                return direction === "older" ? resident[0]! < before : resident.at(-1)! > before;
              }, 8);
              await anchor.finish();
              completed = true;
            } finally {
              if (!completed) {
                responseGate.disarm();
              }
              try {
                await anchor?.cancel();
              } finally {
                await entry.dispose();
              }
            }
          };
          const recordWindow = async (direction: string) => {
            const numbers = await residentNumbers();
            expect(numbers).toEqual(
              Array.from({ length: numbers.length }, (_, index) => numbers[0]! + index),
            );
            const jsonUnits = await selectedPane.evaluate(
              (element) => JSON.stringify((element as LoadingPane).state.chatMessages).length,
            );
            windows.push({
              direction,
              first: numbers[0]!,
              last: numbers.at(-1)!,
              entries: numbers.length,
              jsonUnits,
            });
            return numbers;
          };
          const { receipts: admissionReceipts, record: recordAdmission } =
            createHistoryAdmissionRecorder(() =>
              olderHistoryRequests(rpc.slice(startupMetrics.length)),
            );
          responseGate?.arm();
          let numbers = await recordWindow("tail");
          let olderPageCommits = 0;
          while (numbers[0]! > 1) {
            const before = numbers[0]!;
            await waitForHistoryGesture();
            await historyGesture("older", before, async () => {
              await thread.evaluate((element) => {
                window.historyPaginationProbe.begin();
                element.scrollTop = 0;
              });
              await page.mouse.wheel(0, -500);
            });
            await expect.poll(async () => (await residentNumbers())[0]).toBeLessThan(before);
            await waitForChatScrollIdle(page);
            numbers = await recordWindow("older");
            olderPageCommits++;
            if (olderPageCommits === 1) {
              await paginationSample;
            }
            recordAdmission("older", numbers);
            expect(olderPageCommits).toBeLessThan(transcriptLength / 2);
          }
          await waitForHistoryGesture();
          await page.mouse.wheel(0, -1_000_000);
          const first = selectedPane
            .locator(".chat-bubble")
            .filter({ hasText: "Synthetic loading proof message 1." });
          await expect
            .poll(() =>
              first.evaluate((element) => {
                const row = element.getBoundingClientRect();
                const threadRect = element.closest(".chat-thread")!.getBoundingClientRect();
                return row.bottom > threadRect.top && row.top < threadRect.bottom;
              }),
            )
            .toBe(true);
          const pagination = await paginationSample;
          const olderEnd = rpc.length;
          // Traverse the same source distance back to 900. The old build may still
          // hold every row; the windowed build must reload evicted newer segments.
          while (numbers.at(-1)! < transcriptLength) {
            const before = numbers.at(-1)!;
            await historyGesture("newer", before, async () => {
              await thread.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
              });
              await page.mouse.wheel(0, 500);
            });
            await expect.poll(async () => (await residentNumbers()).at(-1)).toBeGreaterThan(before);
            await waitForChatScrollIdle(page);
            numbers = await recordWindow("newer");
            recordAdmission("newer", numbers);
          }
          await thread.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await page.mouse.wheel(0, 1_000_000);
          await waitForTail();
          await expect
            .poll(() =>
              selectedPane
                .locator(".chat-bubble")
                .filter({
                  hasText: "Synthetic loading proof message 900.",
                })
                .evaluate((element) => {
                  const row = element.getBoundingClientRect();
                  const threadRect = element.closest(".chat-thread")!.getBoundingClientRect();
                  return row.bottom > threadRect.top && row.top < threadRect.bottom;
                }),
            )
            .toBe(true);
          const engineResult = await engine.stop();
          const wallMs = performance.now() - traversalStarted;
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Performance.enable");
          await cdp.send("HeapProfiler.collectGarbage");
          await cdp.send("HeapProfiler.collectGarbage");
          const { metrics } = await cdp.send("Performance.getMetrics");
          const heapUsedBytes = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
          await cdp.detach();
          const paginationMetrics = structuredClone(rpc.slice(startupMetrics.length));
          const olderPages = olderHistoryRequests(rpc.slice(startupMetrics.length, olderEnd));
          const reversePages = olderHistoryRequests(rpc.slice(olderEnd));
          clock.measuring = false;
          await writeFile(
            path.join(suite.artifactDir, "pagination.json"),
            JSON.stringify({
              pagination,
              windows,
              admissionReceipts,
              anchors,
              negativeCalibration,
              releasedResponses: responseGate?.released,
              mode,
              wallMs,
              engine: engineResult.metrics,
              heapUsedBytes,
              workload: {
                transcriptLength,
                contentRepeats: 72,
                viewport,
                sourcePath: [900, 1, 900],
              },
              runtime: {
                node: process.version,
                versions: process.versions,
                platform: platform(),
                arch: arch(),
                browser: page.context().browser()?.version(),
                cpus: cpus().length,
                freemem: freemem(),
                totalmem: totalmem(),
                load: loadavg(),
              },
              rpc: paginationMetrics,
            }),
          );
          // Keep metric output available on the baseline even when the new bound
          // deliberately fails there; never call that failed baseline a green run.
          expect(
            windows.every((window) => window.entries <= 400 && window.jsonUnits <= 3 * 1024 * 1024),
          ).toBe(true);
          if (responseGate) {
            expect(anchors.filter((anchor) => anchor.direction === "older").length).toBeGreaterThan(
              1,
            );
            expect(anchors.filter((anchor) => anchor.direction === "newer").length).toBeGreaterThan(
              1,
            );
            expect(anchors.every((anchor) => anchor.frames > 1 && anchor.maxDrift <= 2)).toBe(true);
            expect(anchors[0]?.readerMotion).toBeGreaterThan(0);
            expect(negativeCalibration?.maxDrift).toBeGreaterThan(2);
          }
          expect(olderPages.length).toBeGreaterThan(1);
          expect(reversePages.length).toBeGreaterThan(1);
          let olderCursor = selectStartupHistory(startupMetrics, selectedKey)[0]?.olderCursor;
          const covered = new Set<number>();
          const refined = new Set(admissionReceipts.flatMap((receipt) => receipt.refined));
          for (const metric of olderPages) {
            expect(metric.receivedMs).toBeDefined();
            expect(metric.cursor).toBe(olderCursor);
            expect(metric.offset).toBeUndefined();
            expect(Number.isInteger(metric.limit)).toBe(true);
            expect(metric.limit).toBeGreaterThanOrEqual(1);
            expect(metric.limit).toBeLessThanOrEqual(400);
            expect(metric.maxBytes).toBeGreaterThanOrEqual(256 * 1024);
            expect(metric.maxBytes).toBeLessThanOrEqual(3 * 1024 * 1024);
            if (metric.limit! <= 80) {
              expect(metric.maxBytes).toBe(256 * 1024);
            }
            expect(metric.historyBytes).toBeLessThanOrEqual(metric.maxBytes!);
            for (const source of metric.sourceNumbers ?? []) {
              covered.add(source);
            }
            if (!refined.has(metric.requestId)) {
              olderCursor = metric.olderCursor;
            }
          }
          expect(covered.size + initialLoadedMessages).toBe(transcriptLength);
          expect(olderCursor).toBeUndefined();
          for (const metric of reversePages) {
            expect(metric.cursor).toEqual(expect.any(String));
            expect(metric.offset).toBeUndefined();
            expect(Number.isInteger(metric.limit)).toBe(true);
            expect(metric.limit).toBeGreaterThanOrEqual(1);
            expect(metric.limit).toBeLessThanOrEqual(400);
            expect(metric.maxBytes).toBeGreaterThanOrEqual(256 * 1024);
            expect(metric.maxBytes).toBeLessThanOrEqual(3 * 1024 * 1024);
            if (metric.limit! <= 80) {
              expect(metric.maxBytes).toBe(256 * 1024);
            }
            expect(metric.historyBytes).toBeLessThanOrEqual(metric.maxBytes!);
          }
          responseGate?.disarm();
          // Three other conversations retire this pane through the real retained-
          // session owner. Reopening must restore a semantic reader, not just a pixel.
          await thread.evaluate((element) => {
            element.scrollTop = (element.scrollHeight - element.clientHeight) / 3;
            element.dispatchEvent(new Event("scroll", { bubbles: true }));
          });
          await waitForChatScrollIdle(page);
          const readBookmark = () =>
            thread.evaluate((element) => {
              const threadRect = element.getBoundingClientRect();
              const bubble = [
                ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
              ].find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return rect.bottom > threadRect.top && rect.top < threadRect.bottom;
              });
              if (!bubble) {
                throw new Error("Reader bookmark has no visible source");
              }
              return {
                key: bubble.dataset.messageId,
                offset: bubble.getBoundingClientRect().top - threadRect.top,
              };
            });
          const heldBookmark = await readBookmark();
          const sessionLink = (key: string) =>
            page.locator(
              `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
            );
          for (let index = 0; index < 3; index++) {
            const key = `agent:main:unopened-${index}`;
            await sessionLink(key).click();
            await expect
              .poll(() => selectedPane.evaluate((element) => (element as LoadingPane).sessionKey))
              .toBe(key);
            await waitForChatScrollIdle(page);
          }
          await expect
            .poll(() =>
              page
                .locator("openclaw-chat-pane")
                .evaluateAll((elements) =>
                  elements.some(
                    (element) =>
                      (element as LoadingPane).sessionKey ===
                      "agent:main:loading-proof-12345678-0000-4000-8000-000000000001",
                  ),
                ),
            )
            .toBe(false);
          await sessionLink(selectedKey).click();
          await expect
            .poll(() => selectedPane.evaluate((element) => (element as LoadingPane).sessionKey))
            .toBe(selectedKey);
          await waitForChatScrollIdle(page);
          await expect.poll(async () => (await readBookmark()).key).toBe(heldBookmark.key);
          const restoredBookmark = await readBookmark();
          expect(Math.abs(restoredBookmark.offset - heldBookmark.offset)).toBeLessThanOrEqual(2);
          await writeFile(
            path.join(suite.artifactDir, "reading-bookmark.json"),
            JSON.stringify({
              held: heldBookmark,
              restored: restoredBookmark,
              retiredThroughSessions: 3,
            }),
          );
          const selectedStartup = selectStartupHistory(startupMetrics, selectedKey)[0];
          expect(selectedStartup).toBeDefined();
          expect(olderHistoryRequests(startupMetrics)).toHaveLength(0);
          const resolutions = selectRpc(startupMetrics, "sessions.resolve");
          expect(resolutions).toHaveLength(1);
          expect(resolutions[0]).toMatchObject({
            agentId: "main",
            shortId: "12345678",
            resolutionOk: true,
            resolvedKey: selectedKey,
            resolvedAgentId: "main",
          });
          expect(selectStartupHistory(startupMetrics, selectedKey)).toHaveLength(1);
          expect(selectedStartup?.messages).toBeLessThanOrEqual(80);
          expect(selectedStartup?.historyBytes).toBeLessThanOrEqual(256 * 1024);
          const homeStartup = selectStartupHistory(startupMetrics, homeKey)[0];
          expect(homeStartup?.sentMs).toBeGreaterThanOrEqual(
            selectedStartup?.receivedMs ?? Infinity,
          );
          expect(selectRpc(startupMetrics, "chat.history", homeKey)).toHaveLength(0);
          expect(selectRpc(startupMetrics, "agent.identity.get")).toHaveLength(1);
          expect(
            startupMetrics
              .filter((metric) => ["agents.list", "agent.identity.get"].includes(metric.method))
              .every((metric) => metric.inlineAvatar === false),
          ).toBe(true);
          expect(images.some((image) => image.width === 128 && image.height === 128)).toBe(true);
          expect(avatarRequests).toBe(1);

          await selectedPane.getByRole("button", { name: "Scroll to latest", exact: true }).click();
          await waitForTail();
          await page.waitForFunction(() =>
            Object.keys(localStorage).some((key) =>
              key.startsWith("openclaw.control.bootRecord.v1:"),
            ),
          );
          const warmInput: Parameters<typeof persistColdLoadWarmState>[0] = {
            sessionKey: selectedKey,
            sidebarView: "sessions",
          };
          // Sidebar persistence has its own writer; transcript settlement does not flush it.
          await page
            .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
            .waitFor();
          const warmState = await page.evaluate(persistColdLoadWarmState, warmInput);
          const storedSnapshot: unknown = warmState.storage.records.snapshots.find((record) =>
            record.sessionKey.endsWith(`\u0000${selectedKey}`),
          )?.snapshot;
          const currentOwner = await evaluateControlUiContext(page, ({ gateway }) => ({
            gatewayUrl: gateway.connection.gatewayUrl,
            sessionKey: gateway.snapshot.sessionKey,
            recoveryScope: gateway.snapshot.client?.recoveryScope ?? null,
            recoveryScopeReady: gateway.snapshot.client?.recoveryScopeReady ?? false,
            profileId: gateway.snapshot.selfUser?.id ?? null,
          }));
          const gatewayScope = gatewayCredentialScope(currentOwner.gatewayUrl);
          const originScope = gatewayOriginScope(currentOwner.gatewayUrl);
          const bootRecord: unknown = JSON.parse(
            warmState.storage.local.find(
              ([key]) => key === `openclaw.control.bootRecord.v1:${gatewayScope}`,
            )?.[1] ?? "null",
          );
          const savedSettings: unknown = JSON.parse(
            warmState.storage.local.find(
              ([key]) => key === `openclaw.control.settings.v1:${originScope}`,
            )?.[1] ?? "null",
          );
          const savedSelection =
            isRecord(savedSettings) && isRecord(savedSettings.sessionsByGateway)
              ? savedSettings.sessionsByGateway[originScope]
              : null;
          const cacheBeforeReload = {
            currentSessionMatches: currentOwner.sessionKey === selectedKey,
            savedSessionMatches:
              isRecord(savedSelection) && savedSelection.sessionKey === selectedKey,
            recoveryScopeReady: currentOwner.recoveryScopeReady,
            bootScopeMatches: isRecord(bootRecord) && bootRecord.scope === gatewayScope,
            bootOwnerMatches:
              isRecord(bootRecord) &&
              currentOwner.recoveryScope !== null &&
              bootRecord.recoveryScope === currentOwner.recoveryScope,
            bootProfileMatches:
              isRecord(bootRecord) && bootRecord.profileId === currentOwner.profileId,
            bootFromCurrentDocument:
              isRecord(bootRecord) &&
              typeof bootRecord.savedAt === "number" &&
              bootRecord.savedAt >= clock.startedAt,
            messages: warmState.messages,
            cursorPresent:
              isRecord(storedSnapshot) && typeof storedSnapshot.deltaCursor === "string",
            bootRecordPresent: warmState.storage.local.some(([key]) =>
              key.startsWith("openclaw.control.bootRecord.v1:"),
            ),
          };
          await page.evaluate(() => sessionStorage.setItem("loading-proof-warm-reload", "true"));
          const warmStart = rpc.length;
          pending.clear();
          clock.startedAt = Date.now();
          clock.measuring = true;
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await waitForTail();
          await composer.waitFor();
          await waitForStartupCommit(selectedKey, selectedPane, warmStart);
          clock.measuring = false;
          const warmMessageNumbers = await selectedPane.evaluate((element) =>
            (element as LoadingPane).state.chatMessages.map((message) =>
              Number(
                JSON.stringify(message).match(/Synthetic loading proof message (\d+)\./u)?.[1],
              ),
            ),
          );
          expect(warmMessageNumbers.length).toBeGreaterThan(0);
          expect(warmMessageNumbers.length).toBeLessThanOrEqual(transcriptLength);
          expect(warmMessageNumbers).toEqual(
            Array.from(
              { length: warmMessageNumbers.length },
              (_, index) => transcriptLength - warmMessageNumbers.length + index + 1,
            ),
          );
          const warmHistory = selectStartupHistory(rpc.slice(warmStart), selectedKey);
          recordControlUiE2eFailureFacts(page, {
            warmCache: cacheBeforeReload,
            warmMessages: warmMessageNumbers.length,
            warmHistoryRequests: warmHistory.length,
            warmHistory: warmHistory.slice(0, 3).map((metric) => ({
              cursorPresent: metric.cursorPresent ?? false,
              kind: metric.historyKind ?? "missing",
              messages: metric.messages ?? null,
              sentMs: metric.sentMs,
              receivedMs: metric.receivedMs ?? null,
            })),
          });
          await writeFile(
            path.join(suite.artifactDir, "warm-history-payload.json"),
            JSON.stringify(
              {
                transcriptLength,
                shortLinkReload: selectStartupHistory(startupMetrics, selectedKey),
                warmReload: {
                  pathname: new URL(page.url()).pathname,
                  cacheBeforeReload,
                  messages: warmMessageNumbers.length,
                  history: warmHistory,
                },
              },
              null,
              2,
            ),
          );
          expect(warmHistory).toHaveLength(1);
          expect(warmHistory[0]).toMatchObject({
            cursorPresent: true,
            historyKind: "delta",
            messages: 0,
          });
          expect(warmHistory[0]?.responseBytes).toBeLessThan(
            (selectedStartup?.responseBytes ?? 0) * 0.2,
          );
          expect(warmMessageNumbers).toHaveLength(cacheBeforeReload.messages);
        },
      );
    });
  }
});
