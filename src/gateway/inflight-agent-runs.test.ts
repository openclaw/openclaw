import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCommandIngressOpts } from "../commands/agent/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  __test,
  addInflightAgentRun,
  ensureInflightAgentRunLifecycleCleanerStarted,
  listInflightAgentRuns,
  removeInflightAgentRun,
} from "./inflight-agent-runs.js";

const savedEnv = { ...process.env };

async function makeTempStateDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.OPENCLAW_STATE_DIR = dir;
  return dir;
}

afterEach(async () => {
  process.env = { ...savedEnv };
});

describe("inflight agent runs persistence", () => {
  it("adds and removes records", async () => {
    const dir = await makeTempStateDir("openclaw-inflight-agent-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const runId = "run-1";
    const opts: AgentCommandIngressOpts = {
      message: "do work",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      runId,
    };

    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);
    expect((await listInflightAgentRuns(env)).map((r) => r.runId)).toEqual([runId]);

    await removeInflightAgentRun(runId, env);
    expect(await listInflightAgentRuns(env)).toEqual([]);
  });

  it("cleans up on lifecycle end", async () => {
    const dir = await makeTempStateDir("openclaw-inflight-agent-end-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    ensureInflightAgentRunLifecycleCleanerStarted(env);
    const runId = "run-end-1";
    const opts: AgentCommandIngressOpts = {
      message: "do work",
      sessionId: "sess-1",
      deliver: false,
      senderIsOwner: true,
      runId,
    };

    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);
    expect((await listInflightAgentRuns(env)).map((r) => r.runId)).toEqual([runId]);

    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });

    // Cleaner is async; allow a tick.
    await new Promise((r) => setTimeout(r, 5));
    expect(await listInflightAgentRuns(env)).toEqual([]);
  });

  it("uses the state dir in file path resolution", async () => {
    const dir = await makeTempStateDir("openclaw-inflight-agent-path-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const storePath = __test.resolveStorePath(env);
    expect(storePath).toBe(path.join(dir, "inflight-agent-runs.json"));
  });
});
