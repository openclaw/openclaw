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
    async () => {
      const instance = await createOpenClawTestInstance({
        name: "progress-refresh",
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
        const received = Promise.withResolvers<EventFrame>();
        const listener = (event: EventFrame) => {
          if (predicate(event)) {
            received.resolve(event);
          }
        };
        const signal = AbortSignal.timeout(RUN_TIMEOUT_MS);
        const timedOut = () =>
          received.reject(new Error("Timed out waiting for live Gateway event"));
        listeners.add(listener);
        signal.addEventListener("abort", timedOut, { once: true });
        try {
          const [, event] = await Promise.all([trigger(), received.promise]);
          return event;
        } finally {
          listeners.delete(listener);
          signal.removeEventListener("abort", timedOut);
        }
      };
      const workspace = instance.state.workspaceDir;
      const startedPath = path.join(workspace, "started");
      const releasePath = path.join(workspace, "release");
      const launchesPath = path.join(workspace, "launches");
      const commandPath = path.join(workspace, "wait.cjs");
      const taskName = `LIVE_PROGRESS_${randomUUID()}`;
      const finalMarker = `WORK_COMPLETED_${randomUUID()}`;
      const staleMarker = `STALE_${randomUUID()}`;
      const rootRunId = `progress-work-${randomUUID()}`;
      await runQaGatewayFixture(
        async () => {
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
          );
          const identities = await Promise.all(
            ["progress-parent", "progress-refresh"].map((identityKey) =>
              ensurePairedTestGatewayClientIdentity({ identityKey }),
            ),
          );
          expect(identities[0]?.deviceId).not.toBe(identities[1]?.deviceId);
          await instance.startGateway();
          for (const deviceIdentity of identities) {
            clients.push(
              await connectTestGatewayClient({
                url: instance.url,
                token: instance.gatewayToken,
                deviceIdentity,
                caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
                requestTimeoutMs: RUN_TIMEOUT_MS + 5_000,
                ...(clients.length === 0 ? { onEvent } : {}),
              }),
            );
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
          const started = Promise.withResolvers<void>();
          const watcher = watch(workspace, (_event, filename) => {
            if (filename === path.basename(startedPath)) {
              started.resolve();
            }
          });
          watcher.on("error", started.reject);
          const startSignal = AbortSignal.timeout(RUN_TIMEOUT_MS);
          const startTimedOut = () =>
            started.reject(new Error("Live agent did not start the barrier"));
          startSignal.addEventListener("abort", startTimedOut, { once: true });
          try {
            await Promise.all([
              started.promise,
              parent.request("chat.send", {
                sessionKey: SESSION_KEY,
                idempotencyKey: rootRunId,
                message: [
                  `This synthetic task is named ${taskName}; preserve that exact label in any status card.`,
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
            startSignal.removeEventListener("abort", startTimedOut);
          }
          const refresh = async () => {
            const previous = await seedStaleCard();
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
            expect(card?.revision).toBeGreaterThan(previous.revision);
            expect(JSON.stringify(card)).toContain(taskName);
            expect(JSON.stringify(card)).not.toContain(staleMarker);
            if (!accepted) {
              throw new Error("Missing progress refresh receipt");
            }
            return accepted;
          };
          await refresh();
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
            events.some((event) => {
              const payload = asOptionalRecord(event.payload);
              const data = asOptionalRecord(payload?.data);
              return (
                event.event === "agent" &&
                payload?.runId === rootRunId &&
                payload.stream === "tool" &&
                data?.name === "progress_card" &&
                data.phase === "result"
              );
            }),
            "the active parent must execute the refresh tool itself",
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
          const idle = await refresh();
          await waitRun(idle.runId);
          const afterIdle = await readHistory();
          expect(afterIdle.messages).toEqual(beforeIdle.messages);
          expect(afterIdle.sessionInfo.hasActiveRun).toBe(false);
          expect(events.slice(idleEventIndex).filter((event) => event.event === "chat")).toEqual(
            [],
          );
          expect(await fs.readFile(launchesPath, "utf8")).toBe("started\n");
          logLiveProgress("progress refresh: idle card updated without chat or resumed work");
        },
        () => fs.writeFile(releasePath, "release"),
        () =>
          runQaGatewayFixture(
            async () => {},
            ...clients.map((client) => () => client.stopAndWait()),
          ),
        () => instance.cleanup(),
      ).catch((error: unknown) => {
        console.error(instance.logs());
        throw error;
      });
    },
    3 * RUN_TIMEOUT_MS,
  );
});
