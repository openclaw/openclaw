import { randomUUID } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayClient } from "./client.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "./gateway-cli-backend.live-helpers.js";
import * as transcriptReaders from "./session-transcript-readers.js";

const describeLive =
  isLiveTestEnabled() && process.env.OPENAI_API_KEY?.trim() ? describe : describe.skip;

describeLive("transcript presentation backlog through a real Gateway", () => {
  it("converges subscription history after a held canonical read without replaying the burst", async ({
    signal,
  }) => {
    const port = await getFreePort();
    const token = randomUUID();
    const state = await createOpenClawTestState({
      label: "transcript-backlog",
      applyEnv: true,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_GATEWAY_PORT: String(port),
      },
    });
    const model = process.env.OPENCLAW_LIVE_GATEWAY_MODELS?.trim() || "openai/gpt-5.4";
    const key = "agent:probe:backlog";
    const config: OpenClawConfig = {
      gateway: {
        mode: "local",
        port,
        auth: { mode: "token", token },
        controlUi: { enabled: false },
      },
      logging: { file: state.path("gateway.log") },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          model: { primary: model },
          models: { [model]: { agentRuntime: { id: "openclaw" } } },
        },
        entries: { probe: { workspace: state.workspaceDir } },
      },
      tools: { allow: [] },
      secrets: { providers: { default: { source: "env" } } },
      models: {
        mode: "merge",
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    };
    const events: EventFrame[] = [];
    const reset = createDeferred();
    const entered = createDeferred();
    const release = createDeferred();
    let holding = false;
    let reads = 0;
    let resets = 0;
    const read = transcriptReaders.readSessionMessageByIdAsync;
    const spy = vi
      .spyOn(transcriptReaders, "readSessionMessageByIdAsync")
      .mockImplementation(async (...args) => {
        const result = await read(...args);
        if (holding && args[0].sessionKey === key) {
          reads++;
          entered.resolve();
          await release.promise;
        }
        return result;
      });
    let server:
      | Awaited<ReturnType<typeof import("./server-start.js").startGatewayServerCore>>
      | undefined;
    let client: GatewayClient | undefined;
    try {
      await state.writeConfig(config);
      const identity = await ensurePairedTestGatewayClientIdentity({ identityKey: "backlog" });
      const { startGatewayServerCore } = await import("./server-start.js");
      server = await startGatewayServerCore(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      client = await connectTestGatewayClient({
        url: "ws://127.0.0.1:" + port,
        token,
        deviceIdentity: identity,
        requestTimeoutMs: 120_000,
        onEvent: (event) => {
          events.push(event);
          const payload = asNullableRecord(event.payload);
          if (
            holding &&
            event.event === "sessions.changed" &&
            payload?.sessionKey === key &&
            payload.phase === "message" &&
            !payload.messageId
          ) {
            resets++;
            reset.resolve();
          }
        },
      });
      await client.request("sessions.create", {
        agentId: "probe",
        key,
        model,
        cwd: state.workspaceDir,
      });
      await client.request("sessions.messages.subscribe", { key });
      const marker = "BACKLOG-READY-" + randomUUID();
      const result = await client.request<{
        result?: {
          payloads?: Array<{ text?: string }>;
          meta?: { agentMeta?: { provider?: string; model?: string } };
        };
      }>(
        "agent",
        {
          agentId: "probe",
          sessionKey: key,
          message: "Do not use tools. Reply with exactly " + marker,
          idempotencyKey: randomUUID(),
          deliver: false,
        },
        { expectFinal: true, timeoutMs: 120_000 },
      );
      expect(result.result?.payloads?.some((payload) => payload.text?.includes(marker))).toBe(true);
      expect(result.result?.meta?.agentMeta).toMatchObject({
        provider: "openai",
        model: model.slice("openai/".length),
      });
      const historyBefore = await client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey: key,
        limit: 200,
      });
      expect(JSON.stringify(historyBefore.messages)).toContain(marker);
      events.length = 0;
      holding = true;
      await client.request("chat.inject", { sessionKey: key, message: "backlog-held" });
      await withinTest(entered.promise, signal);
      for (let index = 0; index < 64; index++) {
        await client.request("chat.inject", { sessionKey: key, message: "backlog-row-" + index });
      }
      expect(reads).toBe(1);
      expect(events.filter((event) => event.event === "session.message")).toHaveLength(0);
      release.resolve();
      await withinTest(reset.promise, signal);
      const historyAfter = await client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey: key,
        limit: 200,
      });
      const text = JSON.stringify(historyAfter.messages);
      expect(text).toContain(marker);
      for (let index = 0; index < 64; index++) {
        expect(text).toContain(JSON.stringify("backlog-row-" + index));
      }
      expect(reads).toBe(1);
      expect(resets).toBe(1);
      expect(events.filter((event) => event.event === "session.message")).toHaveLength(1);
      console.error(
        "[transcript-backlog-live] real model reply persisted; 65 committed injections; one canonical presentation read; one history invalidation; all rows recovered through chat.history",
      );
    } finally {
      release.resolve();
      await client?.stopAndWait();
      await server?.close();
      spy.mockRestore();
      await state.cleanup();
    }
  }, 180_000);
});
