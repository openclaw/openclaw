import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { AgentCommandIngressOpts } from "../commands/agent/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { writeRestartSentinel } from "../infra/restart-sentinel.js";
import { defaultRuntime } from "../runtime.js";
import { __test, addInflightAgentRun } from "./inflight-agent-runs.js";
import { maybeResumeInflightAgentRunsAfterRestart } from "./restart-resume.js";

type AgentCommandFromIngress = typeof import("../commands/agent.js").agentCommandFromIngress;

const savedEnv = { ...process.env };

async function makeTempStateDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.OPENCLAW_STATE_DIR = dir;
  return dir;
}

afterEach(async () => {
  __test.reset();
  process.env = { ...savedEnv };
});

describe("restart resume", () => {
  it("resumes inflight agent runs when restart sentinel kind=restart", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "restart",
      },
      env,
    );

    const runId = "run-resume-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
    });

    expect(result.skipped).toBe(false);
    expect(result.considered).toBe(1);
    expect(result.resumed).toBe(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const calledOpts = runAgentMock.mock.calls[0]?.[0];
    expect(calledOpts.runId).toBe(runId);
    expect(calledOpts.senderIsOwner).toBe(true);
    expect(calledOpts.message).toMatch(/gateway restarted/i);

    const store = await __test.readStore(env);
    expect(store.runs[runId]?.resumeCount).toBe(1);
  });

  it("skips resuming runs that exceeded the max resume attempts", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-cap-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "restart",
      },
      env,
    );

    const runId = "run-resume-cap-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts, resumeCount: 10 }, env);

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
    });

    expect(result.skipped).toBe(false);
    expect(result.considered).toBe(1);
    expect(result.resumed).toBe(0);
    expect(runAgentMock).toHaveBeenCalledTimes(0);
  });

  it("clears inflight records when enabled but no restart sentinel is present", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-clear-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    const runId = "run-clear-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
    });

    expect(result.skipped).toBe(true);
    expect(result.resumed).toBe(0);
    expect(runAgentMock).toHaveBeenCalledTimes(0);

    const store = await __test.readStore(env);
    expect(Object.keys(store.runs)).toHaveLength(0);
  });
});
