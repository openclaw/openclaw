import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentToolArtifact,
  AgentToolArtifactExport,
  AgentToolArtifactStore,
  AgentToolArtifactWriteOptions,
} from "../agents/filesystem/agent-filesystem.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import {
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  createTrajectoryRuntimeRecorder,
  toTrajectoryToolDefinitions,
} from "./runtime.js";

type TrajectoryRuntimeRecorder = NonNullable<ReturnType<typeof createTrajectoryRuntimeRecorder>>;

const tempDirs: string[] = [];
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function expectTrajectoryRuntimeRecorder(
  recorder: ReturnType<typeof createTrajectoryRuntimeRecorder>,
): TrajectoryRuntimeRecorder {
  expect(recorder).toEqual(expect.objectContaining({ recordEvent: expect.any(Function) }));
  if (recorder === null) {
    throw new Error("Expected trajectory runtime recorder");
  }
  return recorder;
}

function createArtifactStoreRecorder(): {
  writes: AgentToolArtifactWriteOptions[];
  store: AgentToolArtifactStore;
} {
  const writes: AgentToolArtifactWriteOptions[] = [];
  const store: AgentToolArtifactStore = {
    write: (options) => {
      writes.push(options);
      return {
        agentId: "agent-main",
        runId: "run-1",
        artifactId: options.artifactId ?? "generated",
        kind: options.kind,
        metadata: options.metadata ?? {},
        size: Buffer.byteLength(
          Buffer.isBuffer(options.blob) ? options.blob : (options.blob ?? ""),
        ),
        createdAt: 1,
      };
    },
    list: () => [] satisfies AgentToolArtifact[],
    read: () => null satisfies AgentToolArtifactExport | null,
    export: () => [] satisfies AgentToolArtifactExport[],
    deleteAll: () => 0,
  };
  return { writes, store };
}

function useTempStateDir(): void {
  process.env.OPENCLAW_STATE_DIR = makeTempDir();
}

describe("trajectory runtime", () => {
  it("records sanitized runtime events into the agent database by default", () => {
    useTempStateDir();
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      systemPrompt: "system prompt",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
      tools: toTrajectoryToolDefinitions([
        { name: "z-tool", parameters: { z: 1 } },
        { name: "a-tool", description: "alpha", parameters: { a: 1 } },
        { name: " ", description: "ignored" },
      ]),
    });

    const events = listTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1" });
    expect(events).toHaveLength(1);
    const parsed = events[0];
    expect(parsed.type).toBe("context.compiled");
    expect(parsed.source).toBe("runtime");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.data?.tools).toEqual([
      { name: "a-tool", description: "alpha", parameters: { a: 1 } },
      { name: "z-tool", parameters: { z: 1 } },
    ]);
    expect(JSON.stringify(parsed.data)).not.toContain("sk-test-secret-token");
    expect(JSON.stringify(parsed.data)).not.toContain("sk-other-secret-token");
  });

  it("mirrors runtime trajectory capture into the artifact store on flush", async () => {
    useTempStateDir();
    const artifacts = createArtifactStoreRecorder();
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
      artifactStore: artifacts.store,
    });

    recorder?.recordEvent("context.compiled", { prompt: "hello" });
    recorder?.recordEvent("model.completed", { status: "success" });
    await recorder?.flush();

    expect(artifacts.writes).toHaveLength(1);
    expect(artifacts.writes[0]).toMatchObject({
      artifactId: "trajectory-runtime",
      kind: "trajectory/runtime-jsonl",
      metadata: {
        traceSchema: "openclaw-trajectory-artifact",
        schemaVersion: 1,
        source: "runtime",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "responses",
        workspaceDir: "/tmp/workspace",
        runtimeLocator: "sqlite:main:trajectory:session-1",
        eventCount: 2,
      },
    });
    const events = listTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1" });
    expect(artifacts.writes[0]?.blob).toBe(
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  });

  it("bounds large runtime event fields before serialization", () => {
    useTempStateDir();
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt: "x".repeat(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1),
    });

    const events = listTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1" });
    expect(events).toHaveLength(1);
    const parsed = events[0];
    expect(parsed.data?.prompt).toMatchObject({
      truncated: true,
      reason: "trajectory-field-size-limit",
    });
    expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1,
    );
  });

  it("stops runtime capture at the file budget and records a truncation event", async () => {
    useTempStateDir();
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      maxRuntimeFileBytes: 900,
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt: "x".repeat(180),
    });
    runtimeRecorder.recordEvent("prompt.submitted", {
      prompt: "y".repeat(180),
    });
    runtimeRecorder.recordEvent("model.completed", {
      get prompt() {
        throw new Error("stopped recorder should not read dropped payloads");
      },
    });
    await runtimeRecorder.flush();

    const parsed = listTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1" });
    expect(parsed.map((event) => event.type)).toContain("trace.truncated");
    const truncated = parsed.find((event) => event.type === "trace.truncated");
    expect(truncated?.data).toMatchObject({
      reason: "trajectory-runtime-file-size-limit",
      limitBytes: 900,
    });
    expect(truncated?.data?.droppedEvents).toBeGreaterThan(0);
  });

  it("does not record runtime events when explicitly disabled", () => {
    useTempStateDir();
    const recorder = createTrajectoryRuntimeRecorder({
      env: {
        OPENCLAW_TRAJECTORY: "0",
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });

    expect(recorder).toBeNull();
  });
});
