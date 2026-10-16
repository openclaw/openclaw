import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { agentCliCommand } from "./agent-via-gateway.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent CLI session IDs", () => {
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
        ...(mode === "remote"
          ? { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } }
          : {}),
      };
      loadConfig.mockReturnValue(config);
      callGateway.mockResolvedValue({
        runId: "idem-1",
        status: "ok",
        result: { payloads: [{ text: "resumed by Gateway" }] },
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      await agentCliCommand({ message: "resume", agent: "main", sessionId: "saved-id" }, runtime);

      expect(runtime.log).toHaveBeenCalledWith("resumed by Gateway");
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          method: "agent",
          requiredCapabilities: ["agent-session-id-create-v1"],
          params: expect.objectContaining({
            agentId: "main",
            sessionId: "saved-id",
            sessionKey: undefined,
            createSessionIfMissing: true,
          }),
        }),
      );
    },
  );
});
