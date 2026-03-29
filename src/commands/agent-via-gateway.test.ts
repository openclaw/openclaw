import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => ({
  agentCommand: vi.fn(),
}));

import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { callGateway } from "../gateway/call.js";
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
  vi.mocked(callGateway).mockResolvedValue({
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

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = vi.mocked(callGateway).mock.calls[0]?.[0] as { timeoutMs?: number };
      expect(request.timeoutMs).toBe(2_147_000_000);
    });
  });

  it("uses gateway by default", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("hello");
    });
  });

  it("falls back to embedded agent when gateway fails", async () => {
    await withTempStore(async () => {
      vi.mocked(callGateway).mockRejectedValue(new Error("gateway not connected"));
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
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

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("uses exponential backoff when --max-timeout > --timeout", async () => {
    await withTempStore(
      async () => {
        vi.mocked(callGateway)
          .mockRejectedValueOnce(new Error("gateway timeout after 60000ms"))
          .mockRejectedValueOnce(new Error("gateway timeout after 120000ms"))
          .mockResolvedValueOnce({
            runId: "idem-1",
            status: "ok",
            result: {
              payloads: [{ text: "success" }],
              meta: { stub: true },
            },
          });

        await agentCliCommand(
          {
            message: "hi",
            to: "+1555",
            timeout: "60",
            maxTimeout: "300",
          },
          runtime,
        );

        expect(callGateway).toHaveBeenCalledTimes(3);
        const firstCall = vi.mocked(callGateway).mock.calls[0]?.[0] as { timeoutMs?: number };
        const secondCall = vi.mocked(callGateway).mock.calls[1]?.[0] as { timeoutMs?: number };
        expect(firstCall.timeoutMs).toBe(90_000);
        expect(secondCall.timeoutMs).toBe(150_000);
        expect(runtime.log).toHaveBeenCalledWith(
          "Request timed out after 60s, retrying with 120s timeout...",
        );
        expect(runtime.log).toHaveBeenCalledWith(
          "Request timed out after 120s, retrying with 240s timeout...",
        );
      },
      { agents: { defaults: { timeoutSeconds: 600 } } },
    );
  });

  it("does not retry on non-timeout errors", async () => {
    await withTempStore(
      async () => {
        vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway not connected"));

        await agentCliCommand(
          {
            message: "hi",
            to: "+1555",
            timeout: "60",
            maxTimeout: "300",
          },
          runtime,
        );

        expect(callGateway).toHaveBeenCalledTimes(1);
        expect(agentCommand).toHaveBeenCalledTimes(1);
      },
      { agents: { defaults: { timeoutSeconds: 600 } } },
    );
  });

  it("uses config maxTimeoutSeconds when CLI max-timeout not provided", async () => {
    await withTempStore(
      async () => {
        vi.mocked(callGateway)
          .mockRejectedValueOnce(new Error("gateway timeout after 60000ms"))
          .mockResolvedValueOnce({
            runId: "idem-1",
            status: "ok",
            result: {
              payloads: [{ text: "success" }],
              meta: { stub: true },
            },
          });

        await agentCliCommand(
          {
            message: "hi",
            to: "+1555",
            timeout: "60",
          },
          runtime,
        );

        expect(callGateway).toHaveBeenCalledTimes(2);
      },
      { agents: { defaults: { timeoutSeconds: 600, maxTimeoutSeconds: 300 } } },
    );
  });
});
