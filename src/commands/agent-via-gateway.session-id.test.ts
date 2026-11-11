import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayCallDeviceAuth } from "../gateway/call-device-auth.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import { gatewaySuccessReply, remoteGatewayConfig } from "./agent-via-gateway.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const { loadConfig, callGateway } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  callGateway: vi.fn(),
}));

// mock-isolation: Use only synthetic config, never the operator's Gateway state.
vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: loadConfig,
  readGatewayDispatchConfigWithShellEnvFallback: loadConfig,
}));
// mock-isolation: Capture requests without connecting to a running Gateway.
vi.mock("../gateway/call.js", () => ({
  callGateway,
  isGatewayCredentialsRequiredError: vi.fn(),
  isGatewayExplicitAuthRequiredError: vi.fn(),
  isGatewayTransportError: vi.fn(),
  randomIdempotencyKey: () => "idem-1",
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = createTestRuntime();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
});

afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.unstubAllEnvs();
});

it.each(["agents.list", "agent"])(
  "selects local identity storage before remote %s authentication",
  (method) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config: OpenClawConfig = {
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "env", provider: "default", id: "MISSING_AGENT_CLI_DSN" },
          },
        },
        plugins: { enabled: false },
        agents: { entries: { main: {} } },
        ...remoteGatewayConfig,
      };
      await state.writeConfig(config);
      delete process.env.MISSING_AGENT_CLI_DSN;
      resetDatabaseEngineSelectionForTest();
      loadConfig.mockReturnValue(config);
      callGateway.mockImplementation(async (request: CallGatewayOptions) => {
        if (request.method === method) {
          await resolveGatewayCallDeviceAuth({
            opts: { ...request, sharedStateMode: "read-only" },
            url: "wss://gateway.example",
            authMode: "token",
            isImplicitLocalTarget: false,
          });
        }
        return { status: "ok", result: { payloads: [] } };
      });
      await expect(
        agentCliCommand(
          { message: "hello", ...(method === "agent" ? { agent: "main" } : {}) },
          runtime,
        ),
      ).rejects.toThrow("SecretRef is unresolved");
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
    }),
);

it.each(["local", "remote"] as const)(
  "resolves session IDs through the %s Gateway while its local store has no schema",
  async (mode) => {
    const dir = tempDirs.make("openclaw-agent-session-id-");
    const agentDir = path.join(dir, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite")).close();
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: path.join(dir, "agents", "main", "sessions", "sessions.json") },
      ...(mode === "remote" ? remoteGatewayConfig : {}),
    };
    loadConfig.mockReturnValue(config);
    callGateway.mockResolvedValue(gatewaySuccessReply("resumed by Gateway"));

    await agentCliCommand({ message: "resume", agent: "main", sessionId: "saved-id" }, runtime);

    expect(callGateway.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      requiredCapabilities: ["agent-session-id-create-v1"],
      params: {
        agentId: "main",
        sessionId: "saved-id",
        sessionKey: undefined,
        createSessionIfMissing: true,
      },
    });
  },
);
