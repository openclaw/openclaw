import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactEvent } from "./redaction.js";
import { ResearchEventV1Schema } from "./types.js";

let tmpRoot = "";

describe("research events", () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-research-events-"));
    process.env.OPENCLAW_STATE_DIR = tmpRoot;
    delete process.env.OPENCLAW_RESEARCH_MAX_BYTES;
    delete process.env.OPENCLAW_RESEARCH_TTL_DAYS;
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("validates event variants", () => {
    const parsed = ResearchEventV1Schema.parse({
      v: 1,
      ts: Date.now(),
      runId: "run-1",
      sessionId: "session-1",
      agentId: "default",
      kind: "tool.start",
      payload: { toolName: "exec", toolCallId: "call-1" },
    });
    expect(parsed.kind).toBe("tool.start");
  });

  it("redacts sensitive strings", () => {
    const event = redactEvent({
      v: 1,
      ts: Date.now(),
      runId: "run-1",
      sessionId: "session-1",
      agentId: "default",
      kind: "tool.end",
      payload: {
        toolName: "web_fetch",
        toolCallId: "call-1",
        ok: true,
        resultSummary: "Authorization: Bearer sk-abc1234567890token",
      },
    });
    const payload = event.payload as { resultSummary?: string };
    expect(payload.resultSummary).toContain("…");
  });

  it("is a no-op when research is disabled", async () => {
    const { createEventsWriter } = await import("./writer.js");
    const writer = createEventsWriter({
      cfg: { research: { enabled: false } } as never,
      runId: "run-disabled",
      agentId: "default",
      sessionId: "session-disabled",
    });
    await writer.emit({
      v: 1,
      ts: Date.now(),
      runId: "run-disabled",
      sessionId: "session-disabled",
      agentId: "default",
      kind: "run.start",
      payload: {},
    });
    await writer.close();
    const researchDir = path.join(tmpRoot, "research");
    await expect(fs.stat(researchDir)).rejects.toThrow();
  });

  it("does not write rl-feed when learning bridge is disabled", async () => {
    const { createResearchRunContext } = await import("./runtime-hooks.js");
    const ctx = createResearchRunContext({
      cfg: { research: { enabled: true, learningBridge: { enabled: false } } } as never,
      runId: "run-lb-off",
      agentId: "default",
      sessionId: "session-lb-off",
    });
    await ctx.emit({
      kind: "tool.end",
      payload: {
        toolName: "exec",
        toolCallId: "call-1",
        ok: false,
      },
    });
    await ctx.close();
    await expect(fs.stat(path.join(tmpRoot, "rl-feed"))).rejects.toThrow();
  });

  it("writes rl-feed artifacts when learning bridge is enabled", async () => {
    const { createResearchRunContext } = await import("./runtime-hooks.js");
    const ctx = createResearchRunContext({
      cfg: { research: { enabled: true, learningBridge: { enabled: true } } } as never,
      runId: "run-lb-on",
      agentId: "default",
      sessionId: "session-lb-on",
    });
    await ctx.emit({
      kind: "tool.end",
      payload: {
        toolName: "exec",
        toolCallId: "call-1",
        ok: false,
      },
    });
    await ctx.close();
    const rlRoot = path.join(tmpRoot, "rl-feed");
    const entries = await fs.readdir(path.join(rlRoot, "trajectories"));
    expect(entries.some((f) => f.endsWith(".jsonl"))).toBe(true);
  });

  it("writes redacted JSONL when enabled", async () => {
    const { createEventsWriter } = await import("./writer.js");
    const writer = createEventsWriter({
      cfg: { research: { enabled: true } } as never,
      runId: "run-enabled",
      agentId: "default",
      sessionId: "session-enabled",
    });
    await writer.emit({
      v: 1,
      ts: Date.now(),
      runId: "run-enabled",
      sessionId: "session-enabled",
      agentId: "default",
      kind: "tool.end",
      payload: {
        toolName: "exec",
        toolCallId: "call-1",
        ok: false,
        resultSummary: "token=ghp_supersecret1234567890",
      },
    });
    await writer.close();
    const filePath = path.join(
      tmpRoot,
      "research",
      "events",
      "default",
      "session-enabled.events.jsonl",
    );
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).toContain('"kind":"tool.end"');
    expect(raw).not.toContain("ghp_supersecret");
  });

  it("applies retention and rotation deterministically", async () => {
    process.env.OPENCLAW_RESEARCH_MAX_BYTES = "50";
    process.env.OPENCLAW_RESEARCH_TTL_DAYS = "100000";
    const { getResearchArtifactStats } = await import("./writer.js");
    const root = path.join(tmpRoot, "research", "events", "default");
    await fs.mkdir(root, { recursive: true });
    const oldest = path.join(root, "oldest.events.jsonl");
    const newest = path.join(root, "newest.events.jsonl");
    await fs.writeFile(oldest, "x".repeat(40), "utf8");
    await fs.writeFile(newest, "y".repeat(40), "utf8");
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    const newTime = new Date("2020-01-02T00:00:00.000Z");
    await fs.utimes(oldest, oldTime, oldTime);
    await fs.utimes(newest, newTime, newTime);

    const result = await getResearchArtifactStats({ research: { enabled: true } } as never);
    expect(result.stats.totalBytes).toBeLessThanOrEqual(50);
    await expect(fs.stat(newest)).resolves.toBeTruthy();
    await expect(fs.stat(oldest)).rejects.toThrow();
  });
});
