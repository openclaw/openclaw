// Live thinking probe: one real Gateway turn per thinking level per route, recorded as dated raw facts.
// Run through `pnpm test:live:thinking-probe`; it is never part of CI.
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { MODEL_DATA_THINKING_LEVELS } from "../../packages/llm-core/src/model-data.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayClient } from "./client.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "./gateway-cli-backend.live-helpers.js";
import {
  buildThinkingProbeProviderConfig,
  redactThinkingProbeError,
  resolveThinkingProbeRoute,
  startThinkingProbeWireCapture,
  writeThinkingProbeRecord,
  type ThinkingProbeTurn,
} from "./thinking-probe.test-helpers.js";

const MODEL = process.env.OPENCLAW_LIVE_THINKING_PROBE_MODEL?.trim();
const ROUTES = (process.env.OPENCLAW_LIVE_THINKING_PROBE_ROUTES ?? "")
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);
const TURN_TIMEOUT_MS = 180_000;
const REPLY_TEXT_LIMIT = 500;

const describeLive =
  isLiveTestEnabled() && MODEL && ROUTES.length > 0 && !process.env.GITHUB_ACTIONS
    ? describe
    : describe.skip;

type AgentFinal = {
  status?: string;
  summary?: string;
  result?: {
    payloads?: Array<{ text?: string }>;
    meta?: {
      error?: { message?: string };
      agentMeta?: { provider?: string; model?: string; usage?: unknown };
    };
  };
};

async function probeLevel(params: {
  client: GatewayClient;
  agentId: string;
  modelRef: string;
  cwd: string;
  level: string;
  capture: ReturnType<typeof startThinkingProbeWireCapture>;
}): Promise<ThinkingProbeTurn> {
  const key = `agent:${params.agentId}:thinking-${params.level}-${randomUUID()}`;
  params.capture.take();
  const turn: Omit<ThinkingProbeTurn, "requests"> = { level: params.level };
  try {
    await params.client.request("sessions.create", {
      agentId: params.agentId,
      key,
      model: params.modelRef,
      cwd: params.cwd,
    });
    const final = await params.client.request<AgentFinal>(
      "agent",
      {
        agentId: params.agentId,
        sessionKey: key,
        message: "Do not use tools. Reply with exactly OK.",
        thinking: params.level,
        idempotencyKey: randomUUID(),
        deliver: false,
      },
      { expectFinal: true, timeoutMs: TURN_TIMEOUT_MS },
    );
    const meta = final.result?.meta;
    const reply = final.result?.payloads?.map((payload) => payload.text ?? "").join("\n");
    const error = meta?.error?.message ?? (final.status === "ok" ? undefined : final.summary);
    Object.assign(turn, {
      ...(meta?.agentMeta?.model ? { model: meta.agentMeta.model } : {}),
      ...(meta?.agentMeta?.usage ? { usage: meta.agentMeta.usage } : {}),
      ...(reply ? { reply: redactThinkingProbeError(reply).slice(0, REPLY_TEXT_LIMIT) } : {}),
      ...(error || final.status !== "ok"
        ? { error: redactThinkingProbeError(error ?? `status=${String(final.status)}`) }
        : {}),
    });
  } catch (error) {
    turn.error = redactThinkingProbeError(error);
  }
  return { ...turn, requests: params.capture.take() };
}

describeLive("live thinking probe", () => {
  it(
    "records what each route accepts for every thinking level",
    async () => {
      const model = MODEL as string;
      const rootDir = process.cwd();
      const routes = ROUTES.map((provider) => {
        const route = resolveThinkingProbeRoute(rootDir, provider);
        const envVar = route.envVars.find((name) => process.env[name]?.trim());
        if (!envVar) {
          throw new Error(`export one of ${route.envVars.join(", ")} to probe ${provider}`);
        }
        const probeProvider = `probe-${provider}`;
        return {
          ...route,
          envVar,
          probeProvider,
          modelRef: `${probeProvider}/${model}`,
          row: buildThinkingProbeProviderConfig({ route, model, envVar }),
        };
      });
      const secretValues = routes.flatMap((route) =>
        route.envVars.map((name) => process.env[name]?.trim() ?? ""),
      );

      const port = await getFreePort();
      const token = randomUUID();
      const state = await createOpenClawTestState({
        label: "thinking-probe",
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
      // Install the runtime transport host before wrapping it.
      await import("../agents/ai-transport-runtime-host.js");
      const capture = startThinkingProbeWireCapture();
      const agentId = "probe";
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
            model: { primary: routes[0]?.modelRef, fallbacks: [] },
            models: Object.fromEntries(
              routes.map((route) => [route.modelRef, { agentRuntime: { id: "openclaw" } }]),
            ),
          },
          entries: { [agentId]: { workspace: state.workspaceDir } },
        },
        tools: { allow: [] },
        secrets: { providers: { default: { source: "env" } } },
        models: {
          mode: "merge",
          providers: Object.fromEntries(routes.map((route) => [route.probeProvider, route.row])),
        },
      };
      let server:
        | Awaited<ReturnType<typeof import("./server-start.js").startGatewayServerCore>>
        | undefined;
      let client: GatewayClient | undefined;
      try {
        await state.writeConfig(config);
        const identity = await ensurePairedTestGatewayClientIdentity({
          identityKey: "thinking-probe",
        });
        const { startGatewayServerCore } = await import("./server-start.js");
        server = await startGatewayServerCore(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        client = await connectTestGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          deviceIdentity: identity,
          requestTimeoutMs: TURN_TIMEOUT_MS,
        });
        for (const route of routes) {
          const turns: ThinkingProbeTurn[] = [];
          for (const level of MODEL_DATA_THINKING_LEVELS) {
            const turn = await probeLevel({
              client,
              agentId,
              modelRef: route.modelRef,
              cwd: state.workspaceDir,
              level,
              capture,
            });
            console.error(
              `[thinking-probe] ${route.provider}/${model} ${level}: ${turn.requests
                .map((request) => request.status ?? "no-status")
                .join(",")}${turn.error ? " error" : ""}`,
            );
            turns.push(turn);
          }
          const filePath = await writeThinkingProbeRecord({
            rootDir,
            plugin: route.plugin,
            secretValues,
            record: {
              schemaVersion: 1,
              probedAt: new Date().toISOString(),
              provider: route.provider,
              model,
              envVar: route.envVar,
              row: route.row,
              turns,
            },
          });
          console.error(`[thinking-probe] wrote ${filePath}`);
        }
      } finally {
        capture.close();
        await client?.stopAndWait();
        await server?.close();
        await state.cleanup();
      }
    },
    MODEL_DATA_THINKING_LEVELS.length * TURN_TIMEOUT_MS * Math.max(1, ROUTES.length) + 120_000,
  );
});
