import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { sessionsTailCommand } from "./sessions-tail.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

const sessionKey = "agent:main:telegram:direct:owner";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function makeEvent(params: Partial<TrajectoryEvent> & { type: string; ts: string }): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace-1",
    source: "runtime",
    seq: 1,
    sessionId: "session-one",
    sessionKey,
    ...params,
  };
}

function writeJsonl(filePath: string, events: TrajectoryEvent[]): void {
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

describe("sessionsTailCommand", () => {
  let tmpDir: string;
  let storePath: string;
  let trajectoryPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-tail-"));
    storePath = path.join(tmpDir, "sessions.json");
    trajectoryPath = path.join(tmpDir, "session-one.trajectory.jsonl");
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({
        [sessionKey]: {
          sessionId: "session-one",
          sessionFile: "session-one.jsonl",
          updatedAt: 2,
          status: "running",
        },
      })}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders compact redacted progress lines", async () => {
    const runtime = makeRuntime();
    writeJsonl(trajectoryPath, [
      makeEvent({
        type: "tool.call",
        ts: "2026-05-18T12:04:18.000Z",
        data: { name: "bash", arguments: { command: "echo SECRET" } },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true, output: "SECRET" },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:29.000Z",
        provider: "openai",
        modelId: "gpt-5.2",
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("12:04:18");
    expect(output).toContain("tool.call");
    expect(output).toContain("bash {...redacted...}");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).toContain("model.completed");
    expect(output).toContain("openai/gpt-5.2 done");
    expect(output).not.toContain("SECRET");
  });

  it("honors the tail count before rendering existing trajectory events", async () => {
    const runtime = makeRuntime();
    writeJsonl(trajectoryPath, [
      makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
      makeEvent({
        type: "tool.call",
        ts: "2026-05-18T12:04:18.000Z",
        data: { name: "bash" },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey, tail: "2" }, runtime);

    const output = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).not.toContain("session.started");
    expect(output).toContain("tool.call");
    expect(output).toContain("tool.result");
  });
});
