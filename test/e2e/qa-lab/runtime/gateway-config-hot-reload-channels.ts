import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import type { ChannelAccountSnapshot } from "../../../../src/channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { CronRunLogEntry } from "../../../../src/cron/run-log-types.js";
import type { CronJob } from "../../../../src/cron/types.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";
import { proveHotReloadIrcAccounts } from "./gateway-config-hot-reload-irc.js";
import { proveHotReloadChannelPolicy } from "./gateway-config-hot-reload-policy.js";

const CHANNEL = "qa-channel";
const MODELS = ["mock-openai/gpt-5.6-luna", "mock-openai/gpt-5.6-luna-alt"] as const;
type Evidence = { prefix: string; observation: string; bootId: string; pid: number };

export async function proveHotReloadChannels({
  repoRoot,
  outputDir,
  appendLog,
}: {
  repoRoot: string;
  outputDir: string;
  appendLog: (text: string) => void;
}) {
  const owner = createQaGatewayChild();
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const evidence: Evidence[] = [];
  const failures: Array<{ prefix: string; message: string }> = [];
  const observations: Array<Record<string, unknown>> = [];
  let connection: HotReloadConnection | undefined;
  let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
  let provider: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  await runQaGatewayFixture(
    async () => {
      bus = await startQaBusServer({ state });
      provider = await startQaMockOpenAiServer({ modelRefs: MODELS });
      const mock = provider;
      const active = await owner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(repoRoot, "dist/index.js")],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
        providerBaseUrl: `${mock.baseUrl}/v1`,
        primaryModel: MODELS[0],
        alternateModel: MODELS[1],
        controlUiEnabled: false,
        transport,
        transportBaseUrl: bus.baseUrl,
        mutateConfig: (cfg) => ({
          ...cfg,
          gateway: { ...cfg.gateway, reload: { mode: "hybrid" } },
          session: { ...cfg.session, dmScope: "per-account-channel-peer" },
          channels: {
            ...cfg.channels,
            [CHANNEL]: {
              ...cfg.channels?.[CHANNEL],
              accounts: { default: {}, parked: {} },
              defaultAccount: "default",
            },
          },
        }),
      });
      connection = await connectHotReloadClient(active);
      const primary = connection;
      const pid = active.pid;
      const bootId = primary.bootId;
      assert(pid && bootId);
      const rpc = async <T>(method: string, params: unknown = {}): Promise<T> => {
        const request = () => primary.client.request<T>(method, params, { timeoutMs: 40_000 });
        try {
          return await request();
        } catch (error) {
          const failure = error as { retryable?: boolean; retryAfterMs?: number; message?: string };
          if (
            !failure.retryable ||
            typeof failure.retryAfterMs !== "number" ||
            !failure.message?.startsWith(`rate limit exceeded for ${method}`)
          ) {
            throw error;
          }
          await delay(failure.retryAfterMs);
          return await request();
        }
      };
      const accounts = async () =>
        (
          await rpc<{ channelAccounts: Record<string, ChannelAccountSnapshot[]> }>(
            "channels.status",
            { probe: false },
          )
        ).channelAccounts[CHANNEL] ?? [];
      const ready = (accountId: string) =>
        waitForHotReloadFact(`${accountId} channel ready`, async () =>
          (await accounts()).find(
            (account) =>
              account.accountId === accountId &&
              account.running &&
              account.connected &&
              account.lifecycle === "ready" &&
              !account.restartPending,
          ),
        );
      await ready("default");
      await ready("parked");
      await rpc("channels.stop", { channel: CHANNEL, accountId: "parked" });
      const stopped = (await accounts()).find((account) => account.accountId === "parked");
      assert(stopped && stopped.running === false && stopped.lifecycle === "stopped");
      const parkedMessage = state.addInboundMessage({
        accountId: "parked",
        conversation: { kind: "direct", id: "hot-reload-parked" },
        senderId: "qa-operator",
        text: "Reply exactly `PARKED_ACCOUNT_RESUMED`",
      });
      const checkStopped = async () => {
        const account = (await accounts()).find((item) => item.accountId === "parked");
        assert(account && account.running === false && account.lifecycle === "stopped");
        assert.equal(account.lastStartAt, stopped.lastStartAt);
        assert(
          !state
            .getSnapshot()
            .messages.some(
              (message) => message.accountId === "parked" && message.direction === "outbound",
            ),
          "Automatic reload resumed a manually stopped account",
        );
        return account;
      };
      const patch = async (change: unknown, replacePaths?: string[], refreshChannel = true) => {
        const previous = await ready("default");
        const snapshot = await rpc<{ hash: string; config: OpenClawConfig }>("config.get");
        const result = await rpc<{
          sentinel: { payload: { stats: { requiresRestart: boolean } } };
        }>("config.patch", { baseHash: snapshot.hash, raw: JSON.stringify(change), replacePaths });
        assert.equal(result.sentinel.payload.stats.requiresRestart, false);
        if (refreshChannel) {
          await waitForHotReloadFact("channel snapshot replaced", async () => {
            const account = await ready("default");
            return (account.lastStartAt ?? 0) > (previous.lastStartAt ?? 0) ? account : undefined;
          });
        }
        await checkStopped();
      };
      const providerRequests = async () => {
        const response = await fetch(`${mock.baseUrl}/debug/requests`);
        assert(response.ok);
        return (await response.json()) as MockOpenAiRequestSnapshot[];
      };
      const record = async (prefix: string, observation: string) => {
        assert.equal((await rpc<{ pid: number }>("system.info")).pid, pid);
        assert.equal(primary.closes, 0);
        assert.equal(primary.hellos, 1);
        const fresh = await connectHotReloadClient(active);
        try {
          assert.equal(fresh.bootId, bootId);
        } finally {
          await fresh.client.stopAndWait();
        }
        observations.push({ prefix, stoppedAccount: await checkStopped() });
        evidence.push({ prefix, observation, bootId, pid });
        appendLog(`PASS channels ${prefix}: ${observation}; PID ${pid}, boot ${bootId}\n`);
      };
      const group = async (prefix: string, run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ prefix, message });
          appendLog(`FAIL channels ${prefix}: ${message}\n`);
        }
      };

      await group("channels.modelByChannel", async () => {
        for (const [index, model] of [MODELS[0], MODELS[1], MODELS[0]].entries()) {
          await patch({ channels: { modelByChannel: { [CHANNEL]: { "*": model } } } });
          const marker = `CHANNEL_MODEL_${index}`;
          const requestCursor = (await providerRequests()).at(-1)?.cursor ?? 0;
          const inbound = await transport.sendInbound({
            conversation: { kind: "direct", id: "hot-reload-model" },
            senderId: "qa-operator",
            text: `Reply exactly \`${marker}\``,
          });
          const cursor = state.getSnapshot().cursor;
          const reply = await transport.waitForOutbound({
            conversation: inbound.conversation,
            textIncludes: marker,
            timeoutMs: 40_000,
          });
          assert.equal(reply.isError, undefined);
          await waitForHotReloadFact("channel turn acknowledged", () =>
            state.getAcknowledgedPollCursor("default") >= cursor ? true : undefined,
          );
          const requests = (await providerRequests()).filter(
            (request) => request.cursor > requestCursor && request.prompt.includes(marker),
          );
          assert(requests.length > 0, "The real channel turn never reached the provider");
          assert(requests.every((request) => request.model === model.split("/")[1]));
          observations.push({
            prefix: "channels.modelByChannel",
            model,
            reply,
            requests: requests.map(({ cursor: requestId, model: wireModel }) => ({
              requestId,
              wireModel,
            })),
          });
        }
        await record(
          "channels.modelByChannel",
          "The same QA conversation delivered three real replies through provider models A→B→A; the running account restarted and the manually stopped account stayed stopped",
        );
      });
      await group("channels.qa-channel automation delivery", async () => {
        const conversationId = "hot-reload-automation";
        const automation = await rpc<CronJob>("cron.add", {
          agentId: "qa",
          name: "Channel hot-reload automation",
          enabled: false,
          deleteAfterRun: false,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Synthetic channel reload automation" },
          delivery: { mode: "none" },
        });
        try {
          for (const [index, notify] of [false, true, false].entries()) {
            const botDisplayName = `QA Hot Reload ${index}`;
            await patch({ channels: { [CHANNEL]: { botDisplayName } } });
            const marker = `CHANNEL_AUTOMATION_${index}`;
            const cursor = (await providerRequests()).at(-1)?.cursor ?? 0;
            const outboundBefore = state
              .getSnapshot()
              .messages.filter(
                (message) =>
                  message.direction === "outbound" && message.conversation.id === conversationId,
              ).length;
            const scheduledAtMs = Date.now() + 1000;
            await rpc("cron.update", {
              id: automation.id,
              patch: {
                enabled: true,
                schedule: { kind: "at", at: new Date(scheduledAtMs).toISOString() },
                payload: { kind: "agentTurn", message: `Reply exactly \`${marker}\`` },
                delivery: notify
                  ? {
                      mode: "announce",
                      channel: CHANNEL,
                      to: `dm:${conversationId}`,
                      accountId: "default",
                    }
                  : { mode: "none" },
              },
            });
            const run = await waitForHotReloadFact(
              "scheduled automation completion",
              async () => {
                const { entries } = await rpc<{ entries: CronRunLogEntry[] }>("cron.runs", {
                  id: automation.id,
                  limit: 10,
                  sortDir: "desc",
                });
                return entries.find(
                  (entry) =>
                    (entry.runAtMs ?? 0) >= scheduledAtMs &&
                    ["ok", "error", "skipped"].includes(entry.status ?? ""),
                );
              },
              40_000,
            );
            assert.equal(run.status, "ok", JSON.stringify(run));
            assert.equal(run.deliveryStatus, notify ? "delivered" : "not-requested");
            const requests = (await providerRequests()).filter(
              (request) => request.cursor > cursor && request.prompt.includes(marker),
            );
            assert(requests.length > 0, "Automation completion must follow an actual model run");
            const delivered = state
              .getSnapshot()
              .messages.filter(
                (message) =>
                  message.direction === "outbound" && message.conversation.id === conversationId,
              );
            assert.equal(delivered.length - outboundBefore, notify ? 1 : 0);
            if (notify) {
              const reply = delivered.at(-1);
              assert(reply);
              assert.equal(reply.text, marker);
              assert.equal(reply.accountId, "default");
              assert.equal(reply.conversation.kind, "direct");
              assert.equal(reply.senderName, botDisplayName);
            }
            observations.push({
              prefix: "channels.qa-channel automation delivery",
              notify,
              botDisplayName,
              jobId: automation.id,
              run,
              delivered: delivered.length,
            });
            await checkStopped();
          }
          await record(
            "channels.qa-channel automation delivery",
            "Naturally scheduled model turns changed non-delivery→one announcement→non-delivery; the announcement used the reloaded channel identity, and the manually stopped account stayed stopped",
          );
        } finally {
          await rpc("cron.remove", { id: automation.id });
        }
      });
      await proveHotReloadChannelPolicy({
        transport,
        state,
        providerRequests,
        rpc,
        patch: (change, replacePaths) => patch(change, replacePaths, false),
        patchChannels: patch,
        proveGroup: group,
        verifyContinuity: record,
      });
      if (failures.length === 0) {
        await rpc("channels.start", { channel: CHANNEL, accountId: "parked" });
        await ready("parked");
        const resumed = await waitForHotReloadFact(
          "explicitly resumed account delivered its queued turn",
          () =>
            state
              .getSnapshot()
              .messages.find(
                (message) =>
                  message.accountId === "parked" &&
                  message.direction === "outbound" &&
                  message.text.includes("PARKED_ACCOUNT_RESUMED"),
              ),
        );
        observations.push({ manuallyResumed: { inboundId: parkedMessage.id, reply: resumed } });
      }
      const irc = await proveHotReloadIrcAccounts({ repoRoot, outputDir, appendLog });
      evidence.push(...irc.evidence);
      failures.push(...irc.failures);
      observations.push(...irc.observations);
    },
    () => connection?.client.stopAndWait(),
    () => stopQaGatewayFixture(owner, { preserveToDir: path.join(outputDir, "channels-gateway") }),
    () => bus?.stop(),
    () => provider?.stop(),
    async () => {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(
        path.join(outputDir, "gateway-config-hot-reload-channels.json"),
        `${JSON.stringify({ evidence, failures, observations }, null, 2)}\n`,
      );
    },
  );
  return { evidence, failures };
}
