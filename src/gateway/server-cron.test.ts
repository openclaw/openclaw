import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));
vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
}));
vi.mock("../cron/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/store.js")>();
  return { ...actual, resolveCronStorePath: vi.fn(() => "") };
});
vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/sessions-test"),
}));
vi.mock("../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn(({ agentId }: { agentId: string }) => `agent:${agentId}:main`),
}));
vi.mock("../infra/heartbeat-runner.js", () => ({
  runHeartbeatOnce: vi.fn().mockResolvedValue({ status: "ok" }),
}));
vi.mock("../infra/heartbeat-wake.js", () => ({ requestHeartbeatNow: vi.fn() }));
vi.mock("../infra/system-events.js", () => ({ enqueueSystemEvent: vi.fn() }));
vi.mock("../logging.js", () => ({
  getChildLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  })),
}));
vi.mock("../cron/run-log.js", () => ({
  appendCronRunLog: vi.fn().mockResolvedValue(undefined),
  resolveCronRunLogPath: vi.fn(() => "/tmp/cron-run-log"),
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: {} }));

import { loadConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { resolveCronStorePath } from "../cron/store.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { buildGatewayCronService } from "./server-cron.js";

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedResolveCronStorePath = vi.mocked(resolveCronStorePath);
const mockedRunIsolated = vi.mocked(runCronIsolatedAgentTurn);
const mockedResolveMainKey = vi.mocked(resolveAgentMainSessionKey);
const mockedEnqueueSystemEvent = vi.mocked(enqueueSystemEvent);

describe("resolveCronAgent agentId resolution", () => {
  let fixtureRoot = "";
  let caseIndex = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "server-cron-test-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Create a unique store path per test case. */
  async function makeStorePath() {
    const dir = path.join(fixtureRoot, `case-${caseIndex++}`);
    await fs.mkdir(dir, { recursive: true });
    const storePath = path.join(dir, "jobs.json");
    mockedResolveCronStorePath.mockReturnValue(storePath);
    return storePath;
  }

  function setupConfig(agentsList: Array<{ id: string }> = [{ id: "main" }]) {
    const cfg = {
      agents: { list: agentsList, defaults: {} },
      cron: { enabled: true },
      session: {},
    };
    mockedLoadConfig.mockReturnValue(cfg as ReturnType<typeof loadConfig>);
    return cfg;
  }

  // --- isolated job path (runIsolatedAgentJob) ---

  it("passes job agentId to isolated run even when agent is not in agents.list", async () => {
    await makeStorePath();
    const cfg = setupConfig();

    const { cron } = buildGatewayCronService({
      cfg: cfg as ReturnType<typeof loadConfig>,
      deps: {} as Parameters<typeof buildGatewayCronService>[0]["deps"],
      broadcast: vi.fn(),
    });
    await cron.start();

    const job = await cron.add({
      name: "ops-task",
      agentId: "ops",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run ops task" },
      delivery: { mode: "none" },
    });

    await cron.run(job.id, "force");

    expect(mockedRunIsolated).toHaveBeenCalledTimes(1);
    expect(mockedRunIsolated).toHaveBeenCalledWith(expect.objectContaining({ agentId: "ops" }));

    cron.stop();
  });

  it("still passes agentId correctly when agent IS in agents.list", async () => {
    await makeStorePath();
    const cfg = setupConfig([{ id: "main" }, { id: "ops" }]);

    const { cron } = buildGatewayCronService({
      cfg: cfg as ReturnType<typeof loadConfig>,
      deps: {} as Parameters<typeof buildGatewayCronService>[0]["deps"],
      broadcast: vi.fn(),
    });
    await cron.start();

    const job = await cron.add({
      name: "listed-agent-task",
      agentId: "ops",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "listed agent run" },
      delivery: { mode: "none" },
    });

    await cron.run(job.id, "force");

    expect(mockedRunIsolated).toHaveBeenCalledWith(expect.objectContaining({ agentId: "ops" }));

    cron.stop();
  });

  it("falls back to default agentId when job has no agentId", async () => {
    await makeStorePath();
    const cfg = setupConfig();

    const { cron } = buildGatewayCronService({
      cfg: cfg as ReturnType<typeof loadConfig>,
      deps: {} as Parameters<typeof buildGatewayCronService>[0]["deps"],
      broadcast: vi.fn(),
    });
    await cron.start();

    const job = await cron.add({
      name: "no-agent-task",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "default agent run" },
      delivery: { mode: "none" },
    });

    await cron.run(job.id, "force");

    expect(mockedRunIsolated).toHaveBeenCalledTimes(1);
    // No agentId on job → should fall back to default ("main").
    expect(mockedRunIsolated).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main" }));

    cron.stop();
  });

  // --- main job path (enqueueSystemEvent) ---

  it("uses job agentId for main-session system events when agent is not in agents.list", async () => {
    await makeStorePath();
    const cfg = setupConfig();

    const { cron } = buildGatewayCronService({
      cfg: cfg as ReturnType<typeof loadConfig>,
      deps: {} as Parameters<typeof buildGatewayCronService>[0]["deps"],
      broadcast: vi.fn(),
    });
    await cron.start();

    const job = await cron.add({
      name: "ops-main-job",
      agentId: "ops",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "ops heartbeat" },
    });

    await cron.run(job.id, "force");

    // The enqueueSystemEvent callback calls resolveAgentMainSessionKey with the agentId.
    // Verify it received "ops" and not "main".
    expect(mockedResolveMainKey).toHaveBeenCalledWith(expect.objectContaining({ agentId: "ops" }));
    // And the real enqueueSystemEvent should get a session key containing "ops".
    expect(mockedEnqueueSystemEvent).toHaveBeenCalledWith(
      "ops heartbeat",
      expect.objectContaining({ sessionKey: "agent:ops:main" }),
    );

    cron.stop();
  });
});
