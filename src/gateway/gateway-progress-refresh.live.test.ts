import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import type { EventFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import type {
  ProgressCardGetResult,
  ProgressCardRefreshResult,
} from "../../packages/gateway-protocol/src/schema/progress-card.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { isLiveTestEnabled, logLiveProgress } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayClient } from "./client.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "./gateway-cli-backend.live-helpers.js";

const describeLive =
  isLiveTestEnabled() && process.env.OPENAI_API_KEY?.trim() ? describe : describe.skip;
const MODEL_KEY = "openai/gpt-5.6-luna";
const RUN_TIMEOUT_MS = 240_000;
const SESSION_KEY = "agent:probe:live-progress-refresh";

type History = {
  messages: Record<string, unknown>[];
  inFlightRun?: { runId: string };
  sessionInfo: {
    agentRuntime?: { id: string };
    hasActiveRun?: boolean;
  };
};

describeLive("progress refresh through the live embedded runtime", () => {
  it(
    "steers the active parent and refreshes an idle card without resuming work or adding chat",
    async ({ signal: testSignal, onTestFinished }) => {
      const stopping = new AbortController();
      const signal = AbortSignal.any([testSignal, stopping.signal]);
      const acquiringInstance = createOpenClawTestInstance({
        name: "progress-refresh",
        signal,
        env: {
          ...Object.fromEntries(
            listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
          ),
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_BASE_URL: undefined,
          OPENAI_API_BASE: undefined,
          OPENCLAW_AGENT_RUNTIME: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
        },
      });
      const clients: GatewayClient[] = [];
      signal.addEventListener(
        "abort",
        () => {
          for (const client of clients) {
            client.stop();
          }
        },
        { once: true },
      );
      const events: EventFrame[] = [];
      const listeners = new Set<(event: EventFrame) => void>();
      const onEvent = (event: EventFrame) => {
        events.push(event);
        for (const listener of listeners) {
          listener(event);
        }
      };
      const waitDuring = async (
        predicate: (event: EventFrame) => boolean,
        trigger: () => Promise<unknown>,
      ) => {
        signal.throwIfAborted();
        const received = createDeferredCore<EventFrame>();
        const listener = (event: EventFrame) => {
          if (predicate(event)) {
            received.resolve(event);
          }
        };
        const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
        const aborted = () => received.reject(waitSignal.reason);
        listeners.add(listener);
        waitSignal.addEventListener("abort", aborted, { once: true });
        try {
          const [, event] = await Promise.all([trigger(), received.promise]);
          signal.throwIfAborted();
          return event;
        } finally {
          listeners.delete(listener);
          waitSignal.removeEventListener("abort", aborted);
        }
      };
      let body: Promise<void> | undefined;
      let cleanupPromise: Promise<void> | undefined;
      const stopClients = () =>
        runQaGatewayFixture(async () => {}, ...clients.map((client) => () => client.stopAndWait()));
      const cleanup = () => {
        stopping.abort();
        return (cleanupPromise ??= acquiringInstance.then((instance) =>
          runQaGatewayFixture(
            () => fs.writeFile(path.join(instance.state.workspaceDir, "release"), "release"),
            stopClients,
            () => instance.stopGateway(),
            async () => {
              await body?.catch(() => {});
            },
            // A pending connection can hand off its client while the body unwinds.
            stopClients,
            () => instance.cleanup(),
          ),
        ));
      };
      onTestFinished(cleanup);
      const instance = await acquiringInstance;
      signal.throwIfAborted();
      const workspace = instance.state.workspaceDir;
      const startedPath = path.join(workspace, "started");
      const releasePath = path.join(workspace, "release");
      const launchesPath = path.join(workspace, "launches");
      const commandPath = path.join(workspace, "wait.cjs");
      const finalMarker = `WORK_COMPLETED_${randomUUID()}`;
      const staleMarker = `STALE_${randomUUID()}`;
      const rootRunId = `progress-work-${randomUUID()}`;
      const ownBody = (run: () => Promise<void>) => () => {
        body = run();
        return body;
      };
      await runQaGatewayFixture(
        ownBody(async () => {
          signal.throwIfAborted();
          instance.state.applyEnv();
          const config: OpenClawConfig = {
            gateway: {
              mode: "local",
              port: instance.port,
              auth: { mode: "token", token: instance.gatewayToken },
              controlUi: { enabled: false },
            },
            agents: {
              defaults: {
                workspace,
                skipBootstrap: true,
                timeoutSeconds: 240,
                thinkingDefault: "low",
                model: { primary: MODEL_KEY },
                models: { [MODEL_KEY]: { agentRuntime: { id: "openclaw" } } },
                sandbox: { mode: "off" },
              },
              entries: { probe: { workspace } },
            },
            tools: {
              allow: ["exec", "process", "progress_card", "read"],
              exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: false },
            },
            secrets: { providers: { default: { source: "env" } } },
            models: {
              mode: "merge",
              providers: {
                openai: {
                  api: "openai-responses",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
          };
          await instance.state.writeConfig(config);
          await fs.writeFile(
            commandPath,
            [
              'const fs = require("node:fs");',
              `fs.appendFileSync(${JSON.stringify(launchesPath)}, "started\\n");`,
              `const watcher = fs.watch(${JSON.stringify(workspace)}, () => {`,
              `  if (fs.existsSync(${JSON.stringify(releasePath)})) {`,
              "    watcher.close();",
              '    console.log("BARRIER_RELEASED");',
              "  }",
              "});",
              `fs.writeFileSync(${JSON.stringify(startedPath)}, "started");`,
            ].join("\n"),
            { signal },
          );
          const identities = [];
          for (const identityKey of ["progress-parent", "progress-refresh"]) {
            signal.throwIfAborted();
            identities.push(await ensurePairedTestGatewayClientIdentity({ identityKey }));
          }
          expect(identities[0]?.deviceId).not.toBe(identities[1]?.deviceId);
          await instance.startGateway();
          for (const deviceIdentity of identities) {
            signal.throwIfAborted();
            clients.push(
              await connectTestGatewayClient({
                url: instance.url,
                token: instance.gatewayToken,
                deviceIdentity,
                caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
                requestTimeoutMs: RUN_TIMEOUT_MS + 5_000,
                onRetry: () => signal.throwIfAborted(),
                ...(clients.length === 0 ? { onEvent } : {}),
              }),
            );
            signal.throwIfAborted();
          }
          const [parent, refresher] = clients;
          if (!parent || !refresher) {
            throw new Error("Missing paired progress clients");
          }
          const readHistory = () =>
            parent.request<History>("chat.history", { sessionKey: SESSION_KEY, limit: 100 });
          const seedStaleCard = async () => {
            const { card } = await parent.request<ProgressCardGetResult>("progressCard.put", {
              sessionKey: SESSION_KEY,
              markdown: staleMarker,
            });
            if (!card) {
              throw new Error("Missing seeded progress card");
            }
            return card;
          };
          const waitRun = async (runId: string) => {
            const result = await parent.request<{ status: string }>("agent.wait", {
              runId,
              timeoutMs: RUN_TIMEOUT_MS,
            });
            expect(result).toMatchObject({ status: "ok" });
          };
          const warmupRunId = `progress-warmup-${randomUUID()}`;
          const warmup = await waitDuring(
            (event) =>
              event.event === "chat" &&
              asOptionalRecord(event.payload)?.runId === warmupRunId &&
              asOptionalRecord(event.payload)?.state === "final",
            () =>
              parent.request("chat.send", {
                sessionKey: SESSION_KEY,
                idempotencyKey: warmupRunId,
                message: "Reply exactly READY. Do not use tools.",
              }),
          );
          expect(extractFirstTextBlock(asOptionalRecord(warmup.payload)?.message)?.trim()).toBe(
            "READY",
          );
          await waitRun(warmupRunId);
          // The previous completed turn must not fence steering of the next active parent.
          signal.throwIfAborted();
          const started = createDeferredCore();
          const watcher = watch(workspace, (_event, filename) => {
            if (filename === path.basename(startedPath)) {
              started.resolve();
            }
          });
          watcher.on("error", started.reject);
          const startSignal = AbortSignal.any([signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
          const startAborted = () => started.reject(startSignal.reason);
          startSignal.addEventListener("abort", startAborted, { once: true });
          try {
            await Promise.all([
              started.promise,
              parent.request("chat.send", {
                sessionKey: SESSION_KEY,
                idempotencyKey: rootRunId,
                message: [
                  `First run exec with command: node ${JSON.stringify(commandPath)}`,
                  "Use yieldMs=1000, then process action=poll with timeout=1000 until it exits. Only the test harness can release the barrier. Do not create or modify files yourself.",
                  "If a progress refresh arrives while waiting, write the current status using progress_card before continuing to poll. Otherwise do not write a card.",
                  `After the command exits, reply exactly ${finalMarker}, then stop.`,
                  "There is a second pending step: running the same command again. Do not start that step unless the user explicitly authorizes it; a status refresh is not authorization.",
                ].join("\n"),
              }),
            ]);
          } finally {
            watcher.close();
            startSignal.removeEventListener("abort", startAborted);
          }
          const refresh = async () => {
            signal.throwIfAborted();
            const previous = await seedStaleCard();
            const eventIndex = events.length;
            let accepted: ProgressCardRefreshResult | undefined;
            await waitDuring(
              (event) => {
                const payload = asOptionalRecord(event.payload);
                return (
                  event.event === "progressCard.changed" &&
                  payload?.sessionKey === previous.sessionKey &&
                  typeof payload.revision === "number" &&
                  payload.revision > previous.revision
                );
              },
              async () => {
                accepted = await refresher.request<ProgressCardRefreshResult>(
                  "progressCard.refresh",
                  {
                    sessionKey: SESSION_KEY,
                    idempotencyKey: randomUUID(),
                  },
                );
                expect(accepted).toMatchObject({ status: "accepted", revision: previous.revision });
              },
            );
            const { card } = await parent.request<ProgressCardGetResult>("progressCard.get", {
              sessionKey: SESSION_KEY,
            });
            if (!card) {
              throw new Error("Missing refreshed progress card");
            }
            expect(card.revision).toBeGreaterThan(previous.revision);
            expect(JSON.stringify(card)).not.toContain(staleMarker);
            if (!accepted) {
              throw new Error("Missing progress refresh receipt");
            }
            return { accepted, eventIndex, revision: card.revision };
          };
          const activeRefresh = await refresh();
          const active = await readHistory();
          expect(active.sessionInfo.hasActiveRun).toBe(true);
          expect(active.inFlightRun?.runId).toBe(rootRunId);
          const final = await waitDuring(
            (event) =>
              event.event === "chat" &&
              asOptionalRecord(event.payload)?.runId === rootRunId &&
              asOptionalRecord(event.payload)?.state === "final",
            () => fs.writeFile(releasePath, "release"),
          );
          await waitRun(rootRunId);
          expect(extractFirstTextBlock(asOptionalRecord(final.payload)?.message)?.trim()).toBe(
            finalMarker,
          );
          expect(
            events.slice(activeRefresh.eventIndex).some((event) => {
              const payload = asOptionalRecord(event.payload);
              const data = asOptionalRecord(payload?.data);
              const details = asOptionalRecord(asOptionalRecord(data?.result)?.details);
              return (
                event.event === "agent" &&
                payload?.runId === rootRunId &&
                payload.stream === "tool" &&
                data?.name === "progress_card" &&
                data.phase === "result" &&
                data.isError !== true &&
                details?.revision === activeRefresh.revision
              );
            }),
            "the active parent must publish the refreshed card revision itself",
          ).toBe(true);
          const beforeIdle = await readHistory();
          expect(beforeIdle.sessionInfo.agentRuntime?.id).toBe("openclaw");
          expect(beforeIdle.messages.filter((message) => message.role === "user")).toHaveLength(2);
          expect(JSON.stringify(beforeIdle.messages)).not.toContain(
            "Refresh this session’s progress card now",
          );
          logLiveProgress(
            `progress refresh: active parent continued and retained its final (${MODEL_KEY})`,
          );

          const idleEventIndex = events.length;
          const { accepted: idle } = await refresh();
          await waitRun(idle.runId);
          const afterIdle = await readHistory();
          expect(afterIdle.messages).toEqual(beforeIdle.messages);
          expect(afterIdle.sessionInfo.hasActiveRun).toBe(false);
          expect(events.slice(idleEventIndex).filter((event) => event.event === "chat")).toEqual(
            [],
          );
          expect(await fs.readFile(launchesPath, "utf8")).toBe("started\n");
          logLiveProgress("progress refresh: idle card updated without chat or resumed work");
        }),
        cleanup,
      ).catch((error: unknown) => {
        console.error(instance.logs());
        throw error;
      });
    },
    3 * RUN_TIMEOUT_MS,
  );
});
