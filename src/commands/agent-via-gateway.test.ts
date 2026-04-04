import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedGatewayAcceptedOwnershipError = vi.hoisted(
  () =>
    class GatewayAcceptedOwnershipError extends Error {
      accepted: Record<string, unknown>;
      cause?: unknown;

      constructor(params: { method: string; accepted: Record<string, unknown>; cause?: unknown }) {
        super(`gateway accepted ownership of ${params.method}`);
        this.name = "GatewayAcceptedOwnershipError";
        this.accepted = params.accepted;
        this.cause = params.cause;
      }
    },
);

vi.mock("../gateway/call.js", () => ({
  GatewayAcceptedOwnershipError: mockedGatewayAcceptedOwnershipError,
  callGateway: vi.fn(),
  isGatewayAcceptedOwnershipError: (err: unknown) =>
    err instanceof mockedGatewayAcceptedOwnershipError,
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => ({
  agentCommand: vi.fn(),
}));

import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import * as gatewayCallModule from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import { agentCommand } from "./agent.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const configSpy = vi.spyOn(configModule, "loadConfig");

function mockConfig(storePath: string, overrides?: Partial<OpenClawConfig>) {
  configSpy.mockReturnValue({
    agents: {
      defaults: {
        timeoutSeconds: 600,
        ...overrides?.agents?.defaults,
      },
    },
    session: {
      store: storePath,
      mainKey: "main",
      ...overrides?.session,
    },
    gateway: overrides?.gateway,
  });
}

async function withTempStore(
  fn: (ctx: { dir: string; store: string }) => Promise<void>,
  overrides?: Partial<OpenClawConfig>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
  const store = path.join(dir, "sessions.json");
  mockConfig(store, overrides);
  try {
    await fn({ dir, store });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mockGatewaySuccessReply(text = "hello") {
  vi.mocked(gatewayCallModule.callGateway).mockResolvedValue({
    runId: "idem-1",
    status: "ok",
    result: {
      payloads: [{ text }],
      meta: { stub: true },
    },
  });
}

function mockLocalAgentReply(text = "local") {
  vi.mocked(agentCommand).mockImplementationOnce(async (_opts, rt) => {
    rt?.log?.(text);
    return {
      payloads: [{ text }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    } as unknown as Awaited<ReturnType<typeof agentCommand>>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentCliCommand", () => {
  it("uses a timer-safe max gateway timeout when --timeout is 0", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555", timeout: "0" }, runtime);

      expect(gatewayCallModule.callGateway).toHaveBeenCalledTimes(1);
      const request = vi.mocked(gatewayCallModule.callGateway).mock.calls[0]?.[0] as {
        timeoutMs?: number;
      };
      expect(request.timeoutMs).toBe(2_147_000_000);
      expect((request as { params?: { timeout?: unknown } }).params?.timeout).toBeUndefined();
    });
  });

  it("keeps gateway timeout client-side instead of forwarding it into the accepted run", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555", timeout: "1" }, runtime);

      expect(gatewayCallModule.callGateway).toHaveBeenCalledTimes(1);
      const request = vi.mocked(gatewayCallModule.callGateway).mock.calls[0]?.[0] as {
        timeoutMs?: number;
        params?: { timeout?: unknown };
      };
      expect(request.timeoutMs).toBe(31_000);
      expect(request.params?.timeout).toBeUndefined();
    });
  });

  it("uses gateway by default", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(gatewayCallModule.callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("hello");
    });
  });

  it("does not fall back locally after gateway acceptance", async () => {
    await withTempStore(async () => {
      vi.mocked(gatewayCallModule.callGateway).mockRejectedValue(
        new mockedGatewayAcceptedOwnershipError({
          method: "agent",
          accepted: {
            runId: "run-accepted",
            status: "accepted",
            acceptedAt: 123,
          },
          cause: new Error("gateway request timeout for agent"),
        }),
      );

      const response = await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(gatewayCallModule.callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(
        "Gateway accepted run run-accepted; not falling back to embedded after gateway transport failure.",
      );
      expect(response).toMatchObject({
        runId: "run-accepted",
        status: "accepted",
      });
    });
  });

  it("falls back to embedded agent when gateway fails", async () => {
    await withTempStore(async () => {
      vi.mocked(gatewayCallModule.callGateway).mockRejectedValue(
        new Error("gateway not connected"),
      );
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(gatewayCallModule.callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("skips gateway when --local is set", async () => {
    await withTempStore(async () => {
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          to: "+1555",
          local: true,
        },
        runtime,
      );

      expect(gatewayCallModule.callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(vi.mocked(agentCommand).mock.calls[0]?.[0]).toMatchObject({
        cleanupBundleMcpOnRunEnd: true,
      });
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("does not force bundle MCP cleanup on gateway fallback", async () => {
    await withTempStore(async () => {
      vi.mocked(gatewayCallModule.callGateway).mockRejectedValue(
        new Error("gateway not connected"),
      );
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(vi.mocked(agentCommand).mock.calls[0]?.[0]).not.toMatchObject({
        cleanupBundleMcpOnRunEnd: true,
      });
    });
  });
});
