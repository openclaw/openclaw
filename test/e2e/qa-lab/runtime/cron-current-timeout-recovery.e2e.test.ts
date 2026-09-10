import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as providerStreams from "../../../../src/agents/provider-stream.js";
import type { StreamFn } from "../../../../src/agents/runtime/index.js";
import { createZeroUsageFixture } from "../../../../src/agents/test-helpers/usage-fixtures.js";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import { getRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resolveSessionStorePathCore } from "../../../../src/config/sessions/paths.js";
import {
  replaceSessionEntry,
  loadTranscriptEvents,
} from "../../../../src/config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../../../src/config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { createAssistantMessageEventStream } from "../../../../src/llm/utils/event-stream.js";
import {
  beginSessionWorkAdmission,
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../../../src/sessions/session-lifecycle-admission.js";
import { openOpenClawStateDatabase } from "../../../../src/state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it(
  "retires a timed-out current completion while its source turn stays active",
  { timeout: 120_000 },
  async () => {
    const envKeys = [
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_TEST_MINIMAL_GATEWAY",
      "OPENCLAW_SKIP_CHANNELS",
      "OPENCLAW_SKIP_GMAIL_WATCHER",
      "OPENCLAW_SKIP_CRON",
      "OPENCLAW_SKIP_CANVAS_HOST",
      "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
      "OPENCLAW_SKIP_PROVIDERS",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    ];
    const env = captureEnv(envKeys);
    const home = tempDirs.make("cron-current-timeout-proof-");
    const stateDir = path.join(home, ".openclaw");
    const workspace = path.join(home, "workspace");
    const plugins = path.join(home, "empty-plugins");
    await Promise.all(
      [stateDir, workspace, plugins].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    const token = "synthetic-cron-recovery-token";
    for (const [key, value] of Object.entries({
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "0",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: plugins,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    })) {
      setTestEnvValue(key, value);
    }
    for (const key of [
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_TEST_MINIMAL_GATEWAY",
    ]) {
      deleteTestEnvValue(key);
    }
    let calls = 0;
    // Only inference is controlled. Cron execution, source-session admission,
    // cancellation, transcript persistence, and receipt settlement remain real.
    const controlledStream: StreamFn = (model) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "CRON_CURRENT_RECOVERY_OK" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: createZeroUsageFixture(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      stream.end();
      return stream;
    };
    const providerSpy = vi
      .spyOn(providerStreams, "registerProviderStreamForModel")
      .mockReturnValue(controlledStream);
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let source: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    try {
      const provider = buildMockOpenAiResponsesProvider("https://cron-proof.invalid/v1", "gpt-4o");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace,
            skipBootstrap: true,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
          entries: { main: { default: true } },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: provider.config,
          },
        },
        gateway: { auth: { mode: "token", token } },
        plugins: { slots: { memory: "none" } },
        cron: { enabled: true },
      };
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath: path.join(stateDir, "openclaw.json"),
        token,
        clientDisplayName: "cron-current-timeout-proof",
      });
      const runtime = getRuntimeConfigSnapshot();
      if (!runtime) {
        throw new Error("No runtime config");
      }
      withFastReplyConfig(runtime);
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      const sessionKey = "agent:main:dashboard:cron-source";
      const sessionId = "cron-source-session";
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId,
          lifecycleRevision: "source-generation",
          updatedAt: Date.now(),
          spawnedCwd: workspace,
        },
      );
      source = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
      const client = gateway.client;
      const job = await client.request<{ id: string }>("cron.add", {
        name: "Current timeout recovery",
        agentId: "main",
        enabled: true,
        sessionTarget: "current",
        sessionKey,
        schedule: { kind: "every", everyMs: 900000 },
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Reply only CRON_CURRENT_RECOVERY_OK",
          model: provider.modelRef,
          lightContext: true,
          timeoutSeconds: 5,
          toolsAllow: [],
        },
        delivery: { mode: "announce" },
      });
      const first = await client.request<{ runId: string }>("cron.run", {
        id: job.id,
        mode: "force",
      });
      type Entry = { runId: string; status: string; error?: string; sessionKey?: string };
      const readRun = async (runId: string) =>
        (
          await client.request<{ entries: Entry[] }>("cron.runs", { id: job.id, limit: 10 })
        ).entries.find((entry) => entry.runId === runId);
      let terminal: Entry | undefined;
      await vi.waitFor(
        async () => {
          terminal = await readRun(first.runId);
          expect(terminal?.status).toBe("error");
        },
        { timeout: 20000, interval: 100 },
      );
      expect(terminal?.error).toContain("timed out");
      expect(calls, JSON.stringify(terminal)).toBe(1);
      const state = await client.request<{ state: { runningAtMs?: number; queuedAtMs?: number } }>(
        "cron.get",
        { id: job.id },
      );
      expect(state.state.runningAtMs).toBeUndefined();
      expect(state.state.queuedAtMs).toBeUndefined();
      const receipt = () =>
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT status FROM cron_run_receipts WHERE job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
          )
          .get(job.id);
      await vi.waitFor(() => expect(receipt()?.status).toBe("error"), {
        timeout: 2000,
        interval: 50,
      });
      expect(isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(true);
      if (terminal?.sessionKey) {
        await expect(
          client.request("sessions.abort", { key: terminal.sessionKey }),
        ).resolves.toMatchObject({ status: "no-active-run" });
      }
      await client.request("cron.update", {
        id: job.id,
        patch: { enabled: false, sessionTarget: "isolated", delivery: { mode: "none" } },
      });
      const retry = await client.request<{ runId: string }>("cron.run", {
        id: job.id,
        mode: "force",
      });
      await vi.waitFor(async () => expect((await readRun(retry.runId))?.status).toBe("ok"), {
        timeout: 20000,
        interval: 100,
      });
      expect(calls).toBe(2);
      expect(isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(true);
      source.release();
      source = undefined;
      // Join older source mutations before reading: releasing the source alone
      // does not prove an abandoned completion has finished its continuation.
      const events = await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        run: () => loadTranscriptEvents({ agentId: "main", sessionKey, sessionId, storePath }),
      });
      expect(
        events.filter((event) => readTranscriptEventMessage(event)?.model === "automation-result"),
      ).toEqual([]);
      console.log(
        JSON.stringify({
          proof: "current-timeout-recovery",
          providerCalls: calls,
          firstStatus: terminal?.status,
          firstError: terminal?.error,
          receiptRetiredBeforeSourceReleased: true,
          disabledForcedRetry: "ok",
          lateSourceAppend: false,
        }),
      );
      await client.request("cron.remove", { id: job.id });
    } finally {
      source?.release();
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Cron timeout proof complete" });
      }
      providerSpy.mockRestore();
      env.restore();
    }
  },
);
