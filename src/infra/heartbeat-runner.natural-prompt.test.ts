import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  runHeartbeatOnce,
  setHeartbeatsEnabled,
  startHeartbeatRunner,
  type HeartbeatRunResult,
  type HeartbeatRunner,
} from "./heartbeat-runner.js";
import { readSessionStoreForTest } from "./heartbeat-runner.test-utils.js";

const cleanupDirs: string[] = [];
const runners: HeartbeatRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    runner.stop();
  }
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  setHeartbeatsEnabled(true);
});

describe("natural heartbeat scheduled prompt", () => {
  it("uses the due HEARTBEAT.md task as the model-facing prompt", async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-natural-heartbeat-"));
    cleanupDirs.push(fixtureDir);
    const workspaceDir = path.join(fixtureDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(workspaceDir, "HEARTBEAT.md"),
      [
        "tasks:",
        "  - name: natural-heartbeat-proof",
        "    interval: 1ms",
        "    prompt: Verify queued heartbeat tasks reach the model request",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: {
            every: "50ms",
            target: "none",
          },
        },
        list: [{ id: "main", default: true }],
      },
      session: { store: path.join(fixtureDir, "sessions.sqlite") },
    } satisfies OpenClawConfig;

    setHeartbeatsEnabled(true);
    const observedContexts: MsgContext[] = [];
    const runResults: HeartbeatRunResult[] = [];
    const runner = startHeartbeatRunner({
      cfg: config,
      readCurrentConfig: () => config,
      runOnce: async (opts) => {
        const result = await runHeartbeatOnce({
          ...opts,
          deps: {
            ...opts.deps,
            getQueueSize: () => 0,
            getReplyFromConfig: async (ctx) => {
              observedContexts.push(ctx);
              return { text: "HEARTBEAT_OK" };
            },
          },
        });
        runResults.push(result);
        return result;
      },
      stableSchedulerSeed: "natural-heartbeat-prompt",
    });
    runners.push(runner);

    await vi.waitFor(
      () => {
        expect(
          observedContexts.length,
          `heartbeat results: ${JSON.stringify(runResults)}`,
        ).toBeGreaterThan(0);
      },
      { timeout: 2_000, interval: 20 },
    );

    expect(observedContexts[0]?.Body).toContain("Run the following periodic tasks");
    expect(observedContexts[0]?.Body).toContain(
      "natural-heartbeat-proof: Verify queued heartbeat tasks reach the model request",
    );
    expect(observedContexts[0]?.Body).not.toContain("[OpenClaw heartbeat poll]");

    const sessionStore = readSessionStoreForTest<{
      heartbeatTaskState?: Record<string, number>;
    }>(path.join(fixtureDir, "sessions.sqlite"));
    expect(
      Object.values(sessionStore).some(
        (entry) => entry.heartbeatTaskState?.["natural-heartbeat-proof"],
      ),
    ).toBe(true);
  });
});
