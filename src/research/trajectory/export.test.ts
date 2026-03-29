import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import { TrajectoryV1Schema } from "../contracts/index.js";
import { exportTrajectoryV1 } from "./export.js";

let tmpRoot = "";

describe("trajectory export", () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trajectory-export-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("exports deterministic bytes with trailing newline", async () => {
    const transcriptPath = path.join(tmpRoot, "session.jsonl");
    const eventsPath = path.join(tmpRoot, "session.events.jsonl");
    const outputPath = path.join(tmpRoot, "trajectory.v1.json");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "world" }] },
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      eventsPath,
      [
        JSON.stringify({
          v: 1,
          ts: 1700000000000,
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "main",
          agentId: "default",
          kind: "tool.start",
          payload: { toolName: "exec", toolCallId: "call-1", argsSummary: "echo hello" },
        }),
        JSON.stringify({
          v: 1,
          ts: 1700000001000,
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "main",
          agentId: "default",
          kind: "tool.end",
          payload: { toolName: "exec", toolCallId: "call-1", ok: true, resultSummary: "ok" },
        }),
      ].join("\n"),
      "utf8",
    );

    const first = await exportTrajectoryV1({
      agentId: "default",
      sessionId: "session-1",
      sessionKey: "main",
      transcriptPath,
      eventsPath,
      outputPath,
    });
    const second = await exportTrajectoryV1({
      agentId: "default",
      sessionId: "session-1",
      sessionKey: "main",
      transcriptPath,
      eventsPath,
      outputPath,
    });

    expect(first.bytes).toBe(second.bytes);
    expect(first.bytes.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(first.bytes) as unknown;
    const schema = validateJsonSchemaValue({
      schema: TrajectoryV1Schema,
      cacheKey: "research.trajectory.export.test",
      value: parsed,
    });
    expect(schema.ok).toBe(true);
  });

  it("does not reintroduce unredacted sensitive event text", async () => {
    const transcriptPath = path.join(tmpRoot, "session-redact.jsonl");
    const eventsPath = path.join(tmpRoot, "session-redact.events.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "run command" } })}\n`,
      "utf8",
    );
    await fs.writeFile(
      eventsPath,
      `${JSON.stringify({
        v: 1,
        ts: 1700000000000,
        runId: "run-1",
        sessionId: "session-redact",
        agentId: "default",
        kind: "tool.end",
        payload: {
          toolName: "web_fetch",
          toolCallId: "call-2",
          ok: false,
          resultSummary: "Authorization: Bearer sk-raw-secret-value",
        },
      })}\n`,
      "utf8",
    );

    const result = await exportTrajectoryV1({
      agentId: "default",
      sessionId: "session-redact",
      transcriptPath,
      eventsPath,
      outputPath: path.join(tmpRoot, "session-redact.trajectory.v1.json"),
    });
    expect(result.bytes).not.toContain("sk-raw-secret-value");
  });

  it("assigns the same stepIdx to multiple tools in one assistant turn", async () => {
    const transcriptPath = path.join(tmpRoot, "session-multi.jsonl");
    const eventsPath = path.join(tmpRoot, "session-multi.events.jsonl");
    const outputPath = path.join(tmpRoot, "session-multi.trajectory.v1.json");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "use two tools" }] },
      })}\n`,
      "utf8",
    );
    const baseEvent = {
      v: 1 as const,
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "main",
      agentId: "default",
    };
    await fs.writeFile(
      eventsPath,
      [
        JSON.stringify({
          ...baseEvent,
          ts: 1700000000000,
          kind: "llm.response",
          payload: { model: "test" },
        }),
        JSON.stringify({
          ...baseEvent,
          ts: 1700000000100,
          kind: "tool.start",
          payload: { toolName: "exec", toolCallId: "call-a", argsSummary: "a" },
        }),
        JSON.stringify({
          ...baseEvent,
          ts: 1700000000200,
          kind: "tool.end",
          payload: { toolName: "exec", toolCallId: "call-a", ok: true, resultSummary: "ok" },
        }),
        JSON.stringify({
          ...baseEvent,
          ts: 1700000000300,
          kind: "tool.start",
          payload: { toolName: "memory_search", toolCallId: "call-b", argsSummary: "b" },
        }),
        JSON.stringify({
          ...baseEvent,
          ts: 1700000000400,
          kind: "tool.end",
          payload: {
            toolName: "memory_search",
            toolCallId: "call-b",
            ok: true,
            resultSummary: "ok",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await exportTrajectoryV1({
      agentId: "default",
      sessionId: "session-1",
      sessionKey: "main",
      transcriptPath,
      eventsPath,
      outputPath,
    });
    const parsed = JSON.parse(result.bytes) as { toolCalls: Array<{ stepIdx: number }> };
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[0]?.stepIdx).toBe(0);
    expect(parsed.toolCalls[1]?.stepIdx).toBe(0);
  });

  it("orders tool.start before tool.end when timestamps tie", async () => {
    const transcriptPath = path.join(tmpRoot, "tie-transcript.jsonl");
    const eventsPath = path.join(tmpRoot, "tie.events.jsonl");
    const outputPath = path.join(tmpRoot, "tie.trajectory.v1.json");
    await fs.writeFile(transcriptPath, "", "utf8");
    const baseEvent = {
      v: 1 as const,
      ts: 1700000000000,
      runId: "run-tie",
      sessionId: "session-tie",
      agentId: "default",
    };
    await fs.writeFile(
      eventsPath,
      [
        JSON.stringify({
          ...baseEvent,
          kind: "tool.end",
          payload: {
            toolName: "exec",
            toolCallId: "call-tie",
            ok: true,
            resultSummary: "done",
          },
        }),
        JSON.stringify({
          ...baseEvent,
          kind: "tool.start",
          payload: {
            toolName: "exec",
            toolCallId: "call-tie",
            argsSummary: "run",
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const result = await exportTrajectoryV1({
      agentId: "default",
      sessionId: "session-tie",
      transcriptPath,
      eventsPath,
      outputPath,
    });
    const parsed = JSON.parse(result.bytes) as {
      events: Array<{ kind: string }>;
    };
    const toolKinds = parsed.events
      .filter((e) => e.kind === "tool.start" || e.kind === "tool.end")
      .map((e) => e.kind);
    expect(toolKinds).toEqual(["tool.start", "tool.end"]);
  });
});
