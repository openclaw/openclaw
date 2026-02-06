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
import { agentCliCommand, emitNdjsonLine } from "./agent-via-gateway.js";
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentCliCommand", () => {
  it("uses gateway by default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
    const store = path.join(dir, "sessions.json");
    mockConfig(store);

    vi.mocked(callGateway).mockResolvedValue({
      runId: "idem-1",
      status: "ok",
      result: {
        payloads: [{ text: "hello" }],
        meta: { stub: true },
      },
    });

    try {
      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("hello");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to embedded agent when gateway fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
    const store = path.join(dir, "sessions.json");
    mockConfig(store);

    vi.mocked(callGateway).mockRejectedValue(new Error("gateway not connected"));
    vi.mocked(agentCommand).mockImplementationOnce(async (_opts, rt) => {
      rt.log?.("local");
      return { payloads: [{ text: "local" }], meta: { stub: true } };
    });

    try {
      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips gateway when --local is set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
    const store = path.join(dir, "sessions.json");
    mockConfig(store);

    vi.mocked(agentCommand).mockImplementationOnce(async (_opts, rt) => {
      rt.log?.("local");
      return { payloads: [{ text: "local" }], meta: { stub: true } };
    });

    try {
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes to streaming gateway path when --stream-json is set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
    const store = path.join(dir, "sessions.json");
    mockConfig(store);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // callGateway should receive an onEvent callback when streaming
    vi.mocked(callGateway).mockImplementation(async (opts) => {
      // Simulate a couple of gateway events via the onEvent callback
      const onEvent = (opts as { onEvent?: (evt: unknown) => void }).onEvent;
      if (onEvent) {
        onEvent({
          event: "chat",
          payload: { runId: "r1", state: "delta", message: { text: "he" } },
          seq: 1,
        });
        onEvent({
          event: "chat",
          payload: { runId: "r1", state: "final", message: { text: "hello" } },
          seq: 2,
        });
      }
      return { runId: "r1", status: "ok", result: { payloads: [{ text: "hello" }] } };
    });

    try {
      await agentCliCommand({ message: "hi", to: "+1555", streamJson: true }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      // Verify onEvent was passed to callGateway
      const callOpts = vi.mocked(callGateway).mock.calls[0][0] as Record<string, unknown>;
      expect(typeof callOpts.onEvent).toBe("function");

      // Verify NDJSON lines were written to stdout (2 events + 1 result)
      const writes = stdoutSpy.mock.calls.map(([data]) => String(data));
      expect(writes).toHaveLength(3);
      for (const line of writes) {
        // Each line should be valid JSON followed by a newline
        expect(line.endsWith("\n")).toBe(true);
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // The last line should be the result event
      const lastLine = JSON.parse(writes[2]);
      expect(lastLine.event).toBe("result");
      expect(lastLine.status).toBe("ok");

      // Normal log output should NOT be called (NDJSON-only)
      expect(runtime.log).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes --stream-json through to embedded agent when --local is set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
    const store = path.join(dir, "sessions.json");
    mockConfig(store);

    vi.mocked(agentCommand).mockResolvedValueOnce(undefined);

    try {
      await agentCliCommand({ message: "hi", to: "+1555", local: true, streamJson: true }, runtime);

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const passedOpts = vi.mocked(agentCommand).mock.calls[0][0] as Record<string, unknown>;
      expect(passedOpts.streamJson).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("emitNdjsonLine", () => {
  it("writes valid JSON followed by a newline", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      emitNdjsonLine({
        event: "agent",
        runId: "r1",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const output = String(spy.mock.calls[0][0]);
      expect(output.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(output);
      expect(parsed.event).toBe("agent");
      expect(parsed.runId).toBe("r1");
      expect(parsed.data).toEqual({ phase: "start" });
    } finally {
      spy.mockRestore();
    }
  });
});
