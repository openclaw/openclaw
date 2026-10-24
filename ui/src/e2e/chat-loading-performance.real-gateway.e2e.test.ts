import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessages } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { encodePngRgba } from "../../../src/media/png-encode.js";
import { setAvatar } from "../../../src/state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { installHistoryPaginationProbe } from "./chat-history-pagination-probe.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const selectedKey = "agent:main:loading-proof-12345678-0000-4000-8000-000000000001";
const homeKey = "agent:main:main";
const transcriptLength = 900;
const viewport = { width: 1440, height: 900 };
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let instance: OpenClawTestInstance | undefined;
let config: OpenClawConfig;
let originalAvatarBytes = 0;

type RpcMetric = {
  requestId: string;
  method: string;
  sentMs: number;
  receivedMs?: number;
  responseBytes?: number;
  sessionKey?: string;
  agentId?: string;
  shortId?: string;
  limit?: number;
  maxBytes?: number;
  offset?: number;
  messages?: number;
  historyBytes?: number;
  resolvedKey?: string;
  resolvedAgentId?: string;
  resolutionOk?: boolean;
  inlineAvatar?: boolean;
};

type LoadingPane = HTMLElement & {
  sessionKey: string;
  transcriptLoading: boolean;
  updateComplete: Promise<boolean>;
  state: { chatMessages: unknown[] };
  loadingOlder: boolean;
  historyIntentTimer: number | null;
};
const selectRpc = (metrics: readonly RpcMetric[], method: string, sessionKey?: string) =>
  metrics.filter(
    (metric) =>
      metric.method === method && (sessionKey === undefined || metric.sessionKey === sessionKey),
  );
const writeEvidence = (name: string, evidence: unknown) =>
  writeFile(path.join(suite.artifactDir, `${name}.json`), JSON.stringify(evidence, null, 2));
const redactFixtureTokens = (text: string, owner: OpenClawTestInstance) =>
  [owner.gatewayToken, owner.hookToken].reduce(
    (redacted, token) => redacted.replaceAll(token, "[redacted fixture token]"),
    text,
  );

function syntheticAvatar(): Buffer {
  const width = 1254;
  const rgba = Buffer.alloc(width * width * 4);
  let noise = 1;
  for (let pixel = 0; pixel < width * width; pixel += 1) {
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    const shade = noise >>> 24;
    const diamond =
      Math.abs((pixel % width) - width / 2) + Math.abs(Math.floor(pixel / width) - width / 2) < 270;
    rgba[pixel * 4] = diamond ? 240 : 70 + (shade >> 2);
    rgba[pixel * 4 + 1] = diamond ? 240 : 80 + (shade >> 2);
    rgba[pixel * 4 + 2] = diamond ? 255 : 150 + (shade >> 2);
    rgba[pixel * 4 + 3] = 255;
  }
  return encodePngRgba(rgba, width, width);
}

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
      const avatar = syntheticAvatar();
      originalAvatarBytes = avatar.length;
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
      const profileOptions = { env: owner.env };
      const profile = ensureGatewayOwnerProfile("Synthetic Viewer", profileOptions);
      const viewerPixels = Buffer.alloc(64 * 64 * 4);
      for (let offset = 0; offset < viewerPixels.length; offset += 4) {
        viewerPixels.set([190, 130, 70, 255], offset);
      }
      const avatarSaved = setAvatar(
        profile.id,
        encodePngRgba(viewerPixels, 64, 64),
        "image/png",
        profileOptions,
      );
      if (!avatarSaved.ok) {
        throw new Error(`Synthetic viewer avatar failed: ${avatarSaved.error.code}`);
      }
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

suite.define(() => {
  it("loads the selected tail before restored Home and caches shared avatar bytes", async (test) => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const cliJson = async (args: string[]): Promise<Record<string, unknown>> => {
      const result = await owner.cli(["--no-color", ...args]);
      if (result.code !== 0) {
        const diagnostic = redactFixtureTokens([result.stderr, result.stdout].join("\n"), owner);
        throw new Error(
          `${args.slice(0, 3).join(" ")} failed (exit ${String(result.code)}): ${diagnostic}`,
        );
      }
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const call = (method: string, params: Record<string, unknown> = {}) =>
      cliJson(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]);
    const syntheticViewer = await call("users.list");
    expect(
      Array.isArray(syntheticViewer.profiles) &&
        syntheticViewer.profiles.some(
          (profile) =>
            isRecord(profile) &&
            profile.id === "gateway-owner" &&
            profile.displayName === "Synthetic Viewer",
        ),
    ).toBe(true);
    const sessions = [
      { key: selectedKey, label: "Synthetic loading proof", count: transcriptLength },
      { key: homeKey, label: "Synthetic Home", count: transcriptLength },
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `agent:main:unopened-${index}`,
        label: `Unopened synthetic conversation ${index + 1}`,
        count: 150,
      })),
    ];
    let setupClient: GatewayClient | undefined;
    let failedAcquisitionCleanup: Promise<void> | undefined;
    await suite.runScenario(test, {
      retainedState: () => owner.state.root,
      async run(signal) {
        const client = await acquireGatewayTestClient(
          {
            url: owner.url,
            token: owner.gatewayToken,
            env: owner.env,
            clientName: "cli",
            mode: "cli",
            role: "operator",
            instanceId: randomUUID(),
            scopes: ["operator.write"],
            caps: ["ultrafast"],
            deviceIdentity: null,
            deviceAuthScope: owner.url,
            sharedStateMode: "read-only",
            requestTimeoutMs: 10_000,
          },
          {
            signal,
            timeoutMs: 10_000,
            timeoutMessage: "Loading setup client did not connect",
            closeMessage: "Loading setup client closed during connect",
            verifyCleanup: (cleanup) => (failedAcquisitionCleanup = cleanup()),
          },
        );
        setupClient = client;
        for (const session of sessions) {
          signal.throwIfAborted();
          const created = await client.request(
            "sessions.create",
            {
              key: session.key,
              agentId: "main",
              label: session.label,
            },
            { signal, retainSentResultOnAbort: true },
          );
          expect(created.ok).toBe(true);
          signal.throwIfAborted();
          await appendTranscriptMessages(
            {
              agentId: "main",
              sessionKey: session.key,
              sessionId: String(created.sessionId),
              env: owner.env,
            },
            {
              config,
              messages: Array.from({ length: session.count }, (_, index) => ({
                message: {
                  role: index % 2 === 0 ? "user" : "assistant",
                  content: [
                    {
                      type: "text",
                      text: `${session.label} message ${index + 1}.\n\n${"Synthetic transcript content for loading and pagination. ".repeat(72)}`,
                    },
                  ],
                  timestamp: 1_780_000_000_000 + index * 1000,
                },
              })),
            },
          );
        }
        signal.throwIfAborted();
      },
      async close() {
        await failedAcquisitionCleanup;
        await setupClient?.stopAndWait();
      },
    });
    const handoff = await cliJson(["dashboard", "--json"]);
    const url = new URL("/chat/main/12345678", suite.server.baseUrl);
    url.hash = new URL(String(handoff.browserUrl)).hash;
    const artifactDir = suite.artifactDir;
    const rpc: RpcMetric[] = [];
    const olderHistoryRequests = (metrics: readonly RpcMetric[]) =>
      selectRpc(metrics, "chat.history", selectedKey).filter((metric) => (metric.offset ?? 0) > 0);
    let measuring = false;
    let startedAt = 0;
    await suite.withPage(
      {
        viewport,
        serviceWorkers: "block",
        locale: "en-US",
        ...(captureUiProof ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
      },
      async ({ page, context }) => {
        const capture = async (name: string) => {
          if (captureUiProof) {
            await page.screenshot({ path: path.join(artifactDir, name + ".png") });
          }
        };
        await page.addInitScript(() => {
          // Measure short-link resolution, not cached-roster route recovery. Keep
          // restored Home preferences; clear identity admission in each new document
          // because the previous document can persist its boot record on pagehide.
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith("openclaw.control.bootRecord.v1:")) {
              localStorage.removeItem(key);
            }
          }
          window.localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
        });
        const pending = new Map<string, RpcMetric>();
        const waitForStartupResponses = (requestStart = 0) =>
          expect
            .poll(() => {
              const metrics = rpc.slice(requestStart);
              return (
                metrics.some(
                  (metric) =>
                    metric.method === "sessions.resolve" && metric.receivedMs !== undefined,
                ) &&
                metrics
                  .filter((metric) => ["agents.list", "agent.identity.get"].includes(metric.method))
                  .every((metric) => metric.receivedMs !== undefined)
              );
            })
            .toBe(true);
        const waitForStartupCommit = async (
          sessionKey: string,
          pane: Locator,
          requestStart = 0,
        ) => {
          await expect
            .poll(() =>
              selectRpc(rpc.slice(requestStart), "chat.startup", sessionKey).some(
                (metric) => metric.receivedMs !== undefined,
              ),
            )
            .toBe(true);
          await expect
            .poll(() => pane.evaluate((element) => (element as LoadingPane).transcriptLoading))
            .toBe(false);
          await pane.evaluate(async (element) => {
            await (element as LoadingPane).updateComplete;
          });
          return Date.now() - startedAt;
        };
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            if (!measuring) {
              return;
            }
            const frame: unknown = JSON.parse(payload.toString());
            if (
              !isRecord(frame) ||
              typeof frame.id !== "string" ||
              typeof frame.method !== "string"
            ) {
              return;
            }
            const params = isRecord(frame.params) ? frame.params : {};
            const metric: RpcMetric = {
              requestId: frame.id,
              method: frame.method,
              sentMs: Date.now() - startedAt,
              ...(typeof params.sessionKey === "string" ? { sessionKey: params.sessionKey } : {}),
              ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
              ...(typeof params.shortId === "string" ? { shortId: params.shortId } : {}),
              ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
              ...(typeof params.maxBytes === "number" ? { maxBytes: params.maxBytes } : {}),
              ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
            };
            rpc.push(metric);
            pending.set(frame.id, metric);
          });
          socket.on("framereceived", ({ payload }) => {
            if (!measuring) {
              return;
            }
            const frame: unknown = JSON.parse(payload.toString());
            if (!isRecord(frame) || typeof frame.id !== "string") {
              return;
            }
            const metric = pending.get(frame.id);
            if (!metric) {
              return;
            }
            pending.delete(frame.id);
            metric.receivedMs = Date.now() - startedAt;
            metric.responseBytes = Buffer.byteLength(payload);
            const body = isRecord(frame.payload) ? frame.payload : {};
            if (Array.isArray(body.messages)) {
              metric.messages = body.messages.length;
              metric.historyBytes = Buffer.byteLength(JSON.stringify(body.messages));
            }
            if (metric.method === "sessions.resolve" && typeof body.key === "string") {
              metric.resolvedKey = body.key;
              metric.resolvedAgentId = typeof body.agentId === "string" ? body.agentId : undefined;
              metric.resolutionOk = frame.ok === true && body.ok === true;
            }
            metric.inlineAvatar = JSON.stringify(body).includes("data:image/");
          });
        });
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
        const measureLoad = async (homeOpen: boolean, requestStart = 0) => {
          const selectedCommitted = waitForStartupCommit(selectedKey, selectedPane, requestStart);
          const homeCommitted = homeOpen
            ? waitForStartupCommit(homeKey, home.locator("openclaw-chat-pane"), requestStart)
            : Promise.resolve(null);
          await waitForTail();
          const selectedVisibleMs = Date.now() - startedAt;
          await composer.waitFor();
          const composerVisibleMs = Date.now() - startedAt;
          if (homeOpen) {
            await waitForHome();
          }
          const homeVisibleMs = homeOpen ? Date.now() - startedAt : null;
          const [selectedAuthoritativeMs, homeAuthoritativeMs] = await Promise.all([
            selectedCommitted,
            homeCommitted,
          ]);
          return {
            selectedVisibleMs,
            composerVisibleMs,
            homeVisibleMs,
            selectedAuthoritativeMs,
            homeAuthoritativeMs,
          };
        };
        await waitForTail();
        await composer.waitFor();
        await page.locator(".sidebar-footer-bar__home").click();
        await waitForHome();
        await capture("01-restored-home-fixture");

        startedAt = Date.now();
        measuring = true;
        await page.reload();
        await waitForControlUiGatewayReady(page);
        const desktopTiming = await measureLoad(true);
        const entryScripts = await page
          .locator("script[src]")
          .evaluateAll((elements) =>
            elements.map((element) => new URL((element as HTMLScriptElement).src).pathname),
          );
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLImageElement>(".sidebar-agent-card__avatar img")].some(
            (image) => image.complete && image.naturalWidth > 0,
          ),
        );
        await capture("02-selected-and-home-ready");
        // Transcript and roster avatars can render before the dedicated identity reply.
        // Freeze only completed payloads; keep the earlier visibility timings unchanged.
        await waitForStartupResponses();
        const startupMetrics = structuredClone(rpc);
        const images = await page
          .locator(".sidebar-agent-card__avatar img")
          .evaluateAll((elements) =>
            elements.map((element) => {
              const image = element as HTMLImageElement;
              return { width: image.naturalWidth, height: image.naturalHeight };
            }),
          );
        const { resources, avatarUrl } = await page.evaluate(() => {
          const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
          return {
            resources: entries.map((resource) => ({
              path: new URL(resource.name).pathname,
              duration: resource.duration,
              transferSize: resource.transferSize,
              decodedBodySize: resource.decodedBodySize,
            })),
            avatarUrl: entries
              .filter((entry) => new URL(entry.name).pathname === "/avatar/main")
              .toSorted((left, right) => right.decodedBodySize - left.decodedBodySize)[0]?.name,
          };
        });
        const avatarResource = resources
          .filter((resource) => resource.path === "/avatar/main")
          .toSorted((left, right) => right.decodedBodySize - left.decodedBodySize)[0];
        if (!avatarUrl) {
          throw new Error("Browser never requested the configured avatar route");
        }
        const avatarAuth = { Authorization: `Bearer ${owner.gatewayToken}` };
        const firstAvatar = await context.request.get(avatarUrl, { headers: avatarAuth });
        const etag = firstAvatar.headers().etag;
        const revalidated = await context.request.get(avatarUrl, {
          headers: { ...avatarAuth, "If-None-Match": etag ?? "" },
        });
        const cache = {
          status: firstAvatar.status(),
          bytes: (await firstAvatar.body()).length,
          control: firstAvatar.headers()["cache-control"],
          revalidatedStatus: revalidated.status(),
        };

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
        await installHistoryPaginationProbe(selectedPane, transcriptLength, selectedKey);
        const paginationStartedAt = Date.now();
        let loadedMessages = await loadedMessageCount();
        const initialLoadedMessages = loadedMessages;
        let olderPageCommits = 0;
        const olderPageMessageCounts: number[] = [];
        while (loadedMessages < transcriptLength) {
          await waitForHistoryGesture();
          await thread.evaluate((element) => {
            window.historyPaginationProbe.begin();
            element.scrollTop = 0;
          });
          await page.mouse.wheel(0, -500);
          await expect.poll(loadedMessageCount).toBeGreaterThan(loadedMessages);
          const nextLoadedMessages = await loadedMessageCount();
          olderPageMessageCounts.push(nextLoadedMessages - loadedMessages);
          loadedMessages = nextLoadedMessages;
          olderPageCommits += 1;
          expect(loadedMessages).toBeLessThanOrEqual(transcriptLength);
          // A committed page may stage one successor, never drain the remaining history.
          expect(olderHistoryRequests(rpc.slice(startupMetrics.length)).length).toBeLessThanOrEqual(
            olderPageCommits + 1,
          );
        }
        await expect
          .poll(() => olderHistoryRequests(rpc).some((metric) => metric.receivedMs !== undefined))
          .toBe(true);
        expect(loadedMessages).toBe(transcriptLength);
        const paginationLoadedMs = Date.now() - paginationStartedAt;
        await selectedPane.evaluate(async (element) => {
          await (element as LoadingPane).updateComplete;
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
        });
        const paginationRenderedMs = Date.now() - paginationStartedAt;
        const browserPagination = await page.evaluate(async () => {
          await window.historyPaginationProbe.done;
          return window.historyPaginationProbe.result();
        });
        expect(
          await selectedPane.evaluate((element) =>
            (element as LoadingPane).state.chatMessages.map((message) =>
              Number(
                JSON.stringify(message).match(/Synthetic loading proof message (\d+)\./u)?.[1],
              ),
            ),
          ),
        ).toEqual(Array.from({ length: transcriptLength }, (_, index) => index + 1));
        // Each prepend preserves the reader's anchor; another gesture reaches the new start.
        await waitForHistoryGesture();
        await page.mouse.wheel(0, -1_000_000);
        await selectedPane
          .locator(".chat-thread", {
            hasText: "Synthetic loading proof message 1.",
          })
          .waitFor();
        await capture("03-older-history-loaded");
        const paginationMetrics = structuredClone(rpc.slice(startupMetrics.length));
        const olderPages = olderHistoryRequests(paginationMetrics);
        const captureNarrowReload = async (stage: string, homeOpen: boolean) => {
          await page.setViewportSize({ width: 1050, height: 900 });
          const requestStart = rpc.length;
          pending.clear();
          startedAt = Date.now();
          // Keep the same short-link input even if navigation canonicalized the prior URL.
          await page.goto(`${url.origin}${url.pathname}`);
          await waitForControlUiGatewayReady(page);
          const timing = await measureLoad(homeOpen, requestStart);
          await capture(stage);
          await waitForStartupResponses(requestStart);
          return {
            width: 1050,
            homeOpen,
            ...timing,
            startup: structuredClone(rpc.slice(requestStart)),
          };
        };
        const narrowHomeOpen = await captureNarrowReload("04-narrow-home-restored", true);
        await page
          .locator("openclaw-assistant-panel")
          .getByRole("button", { name: "Close assistant sidebar", exact: true })
          .click();
        const narrowHomeClosed = await captureNarrowReload("05-narrow-home-closed", false);
        measuring = false;
        await writeEvidence("loading-evidence", {
          fixture: { synthetic: true, originalAvatarBytes, transcriptLength },
          entryScripts,
          ...desktopTiming,
          startup: startupMetrics,
          pagination: paginationMetrics,
          paginationLoadedMs,
          paginationRenderedMs,
          browserPagination,
          initialLoadedMessages,
          olderPageCommits,
          olderPageMessageCounts,
          narrowHomeOpen,
          narrowHomeClosed,
          images,
          avatarResource,
          cache,
          resources,
        });

        // Save measurements before asserting budgets so failures retain their evidence.
        expect(olderPages).toHaveLength(olderPageCommits);
        expect(olderPages.length).toBeGreaterThan(1);
        expect(olderPages.map((metric) => metric.messages)).toEqual(olderPageMessageCounts);
        let nextOffset = initialLoadedMessages;
        for (const metric of olderPages) {
          expect(metric.receivedMs).toBeDefined();
          expect(metric.offset).toBe(nextOffset);
          expect(metric.maxBytes).toBe(3 * 1024 * 1024);
          expect(metric.historyBytes).toBeLessThanOrEqual(metric.maxBytes!);
          const messages = metric.messages ?? 0;
          expect(messages).toBeGreaterThan(0);
          // This fixture has one visible message per source row.
          nextOffset += messages;
        }
        expect(nextOffset).toBe(transcriptLength);
        const selectedStartup = selectRpc(startupMetrics, "chat.startup", selectedKey)[0];
        expect(selectedStartup).toBeDefined();
        for (const { stage, metrics } of [
          { stage: "desktop-home-restored", metrics: startupMetrics },
          {
            stage: "narrow-home-restored",
            metrics: narrowHomeOpen.startup,
          },
          {
            stage: "narrow-home-closed",
            metrics: narrowHomeClosed.startup,
          },
        ]) {
          expect(olderHistoryRequests(metrics)).toHaveLength(0);
          const resolutions = selectRpc(metrics, "sessions.resolve");
          expect(
            resolutions,
            `${stage} sessions.resolve requests: ${JSON.stringify(resolutions)}`,
          ).toHaveLength(1);
          const resolved = resolutions[0]!;
          expect(resolved).toMatchObject({
            agentId: "main",
            shortId: "12345678",
            resolutionOk: true,
            resolvedKey: selectedKey,
            resolvedAgentId: "main",
          });
          const selected = selectRpc(metrics, "chat.startup", selectedKey);
          expect(selected).toHaveLength(1);
        }
        expect(selectedStartup?.messages).toBeLessThanOrEqual(80);
        expect(selectedStartup?.historyBytes).toBeLessThanOrEqual(256 * 1024);
        const homeStartup = selectRpc(startupMetrics, "chat.startup", homeKey)[0];
        expect(homeStartup?.sentMs).toBeGreaterThanOrEqual(selectedStartup?.receivedMs ?? Infinity);
        for (const metrics of [startupMetrics, narrowHomeOpen.startup]) {
          expect(selectRpc(metrics, "chat.history", homeKey)).toHaveLength(0);
          expect(selectRpc(metrics, "agent.identity.get")).toHaveLength(1);
        }
        expect(
          startupMetrics
            .filter((metric) => ["agents.list", "agent.identity.get"].includes(metric.method))
            .every((metric) => metric.inlineAvatar === false),
        ).toBe(true);
        expect(images.some((image) => image.width === 128 && image.height === 128)).toBe(true);
        expect(avatarResource).toBeDefined();
        expect(resources.filter((resource) => resource.path === "/avatar/main")).toHaveLength(1);
        expect(cache).toMatchObject({ status: 200, revalidatedStatus: 304 });
        expect(cache.bytes).toBeLessThan(originalAvatarBytes / 10);
        expect(cache.control).toContain("immutable");
      },
    );
  });
});
