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
import type { RuntimeEnv } from "../runtime.js";
import * as configModule from "../config/config.js";
import { callGateway } from "../gateway/call.js";
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
    rt.log?.(text);
    return { payloads: [{ text }], meta: { stub: true } };
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
});
