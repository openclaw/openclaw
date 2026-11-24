import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { assertGatewayAgentsAdmitted } from "../../test/helpers/gateway-agent-admission.js";
import {
  CODEX_HARNESS_GATEWAY_LOCAL_TOOLS,
  verifyCodexSubagentNativeShellProbe,
} from "../../test/helpers/gateway-codex-harness-subagent-shell.js";
import {
  createCodexHarnessLiveInstance,
  createCodexHarnessWorkspace,
} from "../../test/helpers/gateway-codex-harness.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "./gateway-cli-backend.live-helpers.js";
import { liveOpenAiApiKeyModels } from "./live-openai-models.test-support.js";

const LIVE =
  isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_CODEX_SUBAGENT_SHELL);
const MODEL_KEY = process.env.OPENCLAW_LIVE_CODEX_HARNESS_MODEL ?? "openai/gpt-5.6-luna";
const THINKING = process.env.OPENCLAW_LIVE_CODEX_HARNESS_THINKING ?? "low";
const AUTH_MODE =
  process.env.OPENCLAW_LIVE_CODEX_HARNESS_AUTH === "api-key" ? "api-key" : "codex-auth";
const REQUEST_TIMEOUT_MS = 300_000;
const AGENT_TIMEOUT_SECONDS = 290;
const describeLive = LIVE ? describe : describe.skip;

function log(step: string, details?: Record<string, unknown>): void {
  console.log(`[codex-subagent-shell] ${step}`, details ? JSON.stringify(details) : "");
}

describeLive("gateway live (Codex hidden subagent native shell)", () => {
  it("keeps native shell and file tools in a hidden subagent without Gateway fallback tools", async () => {
    const token = `test-${randomUUID()}`;
    const instance = await createCodexHarnessLiveInstance(token, AUTH_MODE);
    let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
    try {
      instance.state.applyEnv();
      const workspace = instance.state.workspaceDir;
      await createCodexHarnessWorkspace(workspace);
      // Mirror a dedicated OpenClaw Enterprise Gateway: the Gateway-local
      // replacements for Codex native tools are excluded.
      const cfg: OpenClawConfig = {
        gateway: {
          mode: "local",
          port: instance.port,
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          tools: { allow: ["sessions_spawn"] },
        },
        plugins: {
          allow: ["codex"],
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: { mode: "yolo" },
                codexDynamicToolsExclude: [...CODEX_HARNESS_GATEWAY_LOCAL_TOOLS],
              },
            },
          },
        },
        agents: {
          defaults: {
            workspace,
            skipBootstrap: true,
            timeoutSeconds: AGENT_TIMEOUT_SECONDS,
            thinkingDefault: THINKING,
            model: { primary: MODEL_KEY },
            models: { [MODEL_KEY]: { agentRuntime: { id: "codex" } } },
            sandbox: { mode: "off" },
          },
          entries: {
            dev: {
              workspace,
              model: { primary: MODEL_KEY },
              models: { [MODEL_KEY]: { agentRuntime: { id: "codex" } } },
            },
          },
        },
        ...(AUTH_MODE === "api-key"
          ? {
              secrets: { providers: { default: { source: "env" } } },
              models: liveOpenAiApiKeyModels(),
            }
          : {}),
      } as OpenClawConfig;
      await fs.writeFile(instance.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
        displayName: "vitest-codex-subagent-shell-live",
      });
      await instance.startGateway();
      client = await connectTestGatewayClient({
        url: `ws://127.0.0.1:${instance.port}`,
        token,
        deviceIdentity,
        timeoutMs: 60_000,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        clientDisplayName: "vitest-codex-subagent-shell-live",
      });
      await assertGatewayAgentsAdmitted(client, ["dev"]);
      const sessionKey = "agent:dev:live-codex-subagent-shell";
      // Create the parent session with one ordinary turn before spawning.
      await client.request(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${randomUUID()}`,
          message: "Reply with exactly PARENT-READY and nothing else.",
        },
        { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      await verifyCodexSubagentNativeShellProbe({
        client,
        sessionKey,
        workspace,
        codexHome: path.join(instance.state.stateDir, "agents", "dev", "agent", "codex-home"),
        thinking: THINKING,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        agentTimeoutSeconds: AGENT_TIMEOUT_SECONDS,
        log,
      });
    } finally {
      await client?.stopAndWait();
      await instance.cleanup();
    }
  }, 900_000);
});
