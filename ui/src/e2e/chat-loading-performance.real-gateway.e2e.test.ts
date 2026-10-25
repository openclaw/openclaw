import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessages } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { installHistoryPaginationProbe } from "./chat-history-pagination-probe.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const selectedKey = "agent:main:loading-proof-12345678-0000-4000-8000-000000000001";
const homeKey = "agent:main:main";
const transcriptLength = 900;
const viewport = { width: 1440, height: 900 };
let instance: OpenClawTestInstance | undefined;
let config: OpenClawConfig;

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
  initialHistory?: boolean;
  historyOk?: boolean;
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
const selectStartupHistory = (metrics: readonly RpcMetric[], sessionKey: string) =>
  metrics.filter(
    (metric) =>
      (metric.method === "chat.startup" || metric.initialHistory) &&
      metric.sessionKey === sessionKey,
  );
const redactFixtureTokens = (text: string, owner: OpenClawTestInstance) =>
  [owner.gatewayToken, owner.hookToken].reduce(
    (redacted, token) => redacted.replaceAll(token, "[redacted fixture token]"),
    text,
  );

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
                message: chatMessage(
                  index % 2 === 0 ? "user" : "assistant",
                  `${session.label} message ${index + 1}.\n\n${"Synthetic transcript content for loading and pagination. ".repeat(72)}`,
                  { timestamp: 1_780_000_000_000 + index * 1000 },
                ),
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
      },
      async ({ page }) => {
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
                  .filter((metric) => ["agents.list", "agent.identity.get"].includes(metric.method))
                  .every((metric) => metric.receivedMs !== undefined)
              );
            })
            .toBe(true);
        const waitForStartupCommit = async (sessionKey: string, pane: Locator) => {
          await expect
            .poll(() =>
              selectStartupHistory(rpc, sessionKey).some(
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
            const initialHistory =
              frame.method === "sessions.messages.subscribe" && isRecord(params.initialHistory)
                ? params.initialHistory
                : undefined;
            const historyParams = initialHistory ?? params;
            const metric: RpcMetric = {
              requestId: frame.id,
              method: frame.method,
              sentMs: Date.now() - startedAt,
              ...(typeof params.sessionKey === "string"
                ? { sessionKey: params.sessionKey }
                : initialHistory && typeof params.key === "string"
                  ? { sessionKey: params.key }
                  : {}),
              ...(initialHistory ? { initialHistory: true } : {}),
              ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
              ...(typeof params.shortId === "string" ? { shortId: params.shortId } : {}),
              ...(typeof historyParams.limit === "number" ? { limit: historyParams.limit } : {}),
              ...(typeof historyParams.maxBytes === "number"
                ? { maxBytes: historyParams.maxBytes }
                : {}),
              ...(typeof historyParams.offset === "number" ? { offset: historyParams.offset } : {}),
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
            const initialHistory = isRecord(body.initialHistory) ? body.initialHistory : undefined;
            const history = metric.initialHistory
              ? initialHistory?.ok === true && isRecord(initialHistory.payload)
                ? initialHistory.payload
                : undefined
              : body;
            metric.historyOk = frame.ok === true && history !== undefined;
            if (Array.isArray(history?.messages)) {
              metric.messages = history.messages.length;
              metric.historyBytes = Buffer.byteLength(JSON.stringify(history.messages));
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

        startedAt = Date.now();
        measuring = true;
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await measureLoad();
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLImageElement>(".sidebar-agent-card__avatar img")].some(
            (image) => image.complete && image.naturalWidth > 0,
          ),
        );
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
        await installHistoryPaginationProbe(selectedPane, transcriptLength, selectedKey);
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
        const pagination = await page.evaluate(async () => {
          await window.historyPaginationProbe.done;
          return window.historyPaginationProbe.result();
        });
        await writeFile(
          path.join(suite.artifactDir, "pagination.json"),
          JSON.stringify(pagination),
        );
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
        const paginationMetrics = structuredClone(rpc.slice(startupMetrics.length));
        const olderPages = olderHistoryRequests(paginationMetrics);
        measuring = false;
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
        expect(homeStartup?.sentMs).toBeGreaterThanOrEqual(selectedStartup?.receivedMs ?? Infinity);
        expect(selectRpc(startupMetrics, "chat.history", homeKey)).toHaveLength(0);
        expect(selectRpc(startupMetrics, "agent.identity.get")).toHaveLength(1);
        expect(
          startupMetrics
            .filter((metric) => ["agents.list", "agent.identity.get"].includes(metric.method))
            .every((metric) => metric.inlineAvatar === false),
        ).toBe(true);
        expect(images.some((image) => image.width === 128 && image.height === 128)).toBe(true);
        expect(avatarRequests).toBe(1);
      },
    );
  });
});
