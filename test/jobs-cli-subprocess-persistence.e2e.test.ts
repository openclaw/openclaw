import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDurableJobRecord,
  recordDurableJobTransition,
  resetDurableJobRegistryForTests,
} from "../src/tasks/runtime-internal.js";
import { withTempDir } from "../src/test-helpers/temp-dir.js";

function runJobsCliJson(args: string[], env: NodeJS.ProcessEnv) {
  const entry = path.resolve(process.cwd(), "src", "entry.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  const output = result.stdout.trim() || result.stderr.trim();
  expect(output).not.toBe("");
  return JSON.parse(output) as Record<string, unknown>;
}

describe("jobs cli subprocess persistence", () => {
  it("lists and shows persisted durable jobs from a fresh CLI process", async () => {
    await withTempDir({ prefix: "openclaw-jobs-cli-subprocess-" }, async (root) => {
      const stateDir = path.join(root, "state");
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_STRICT_FAST_REPLY_CONFIG: "1",
      };
      delete env.OPENCLAW_HOME;
      delete env.OPENCLAW_CONFIG_PATH;
      delete env.VITEST;

      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = stateDir;
      resetDurableJobRegistryForTests();

      try {
        const job = createDurableJobRecord({
          jobId: "job-subprocess-proof",
          title: "Subprocess proof",
          goal: "Verify jobs list/show persists across process boundary",
          ownerSessionKey: "agent:main:main",
          status: "waiting",
          stopCondition: { kind: "manual" },
          notifyPolicy: { kind: "state_changes", onCompletion: true },
          currentStep: "await_subprocess",
          summary: "Persisted before fresh CLI process",
          nextWakeAt: 900,
          backing: {
            taskFlowId: "flow-subprocess-proof",
            childSessionKeys: ["agent:coder:subagent:proof"],
          },
          source: { kind: "chat_commitment", messageText: "I'll keep watching this." },
          createdBy: "tests",
          createdAt: 100,
          updatedAt: 120,
        });
        recordDurableJobTransition({
          jobId: job.jobId,
          to: "waiting",
          reason: "Seeded for subprocess proof",
          actor: "tests",
          at: 121,
          disposition: { kind: "notify_and_schedule", notify: true, nextWakeAt: 900 },
          revision: job.audit.revision,
        });

        const listed = runJobsCliJson(["jobs", "list", "--json"], env) as {
          count: number;
          jobs: Array<Record<string, unknown>>;
        };
        expect(listed.count).toBe(1);
        expect(listed.jobs).toEqual([
          expect.objectContaining({
            jobId: "job-subprocess-proof",
            status: "waiting",
            currentStep: "await_subprocess",
            summary: "Persisted before fresh CLI process",
            nextWakeAt: 900,
            backing: expect.objectContaining({
              taskFlowId: "flow-subprocess-proof",
              childSessionKeys: ["agent:coder:subagent:proof"],
            }),
          }),
        ]);

        const shown = runJobsCliJson(["jobs", "show", "job-subprocess-proof", "--json"], env) as {
          jobId: string;
          history: Array<Record<string, unknown>>;
          backing: Record<string, unknown>;
          source: Record<string, unknown>;
        };
        expect(shown).toMatchObject({
          jobId: "job-subprocess-proof",
          status: "waiting",
          currentStep: "await_subprocess",
          source: {
            kind: "chat_commitment",
          },
          backing: {
            taskFlowId: "flow-subprocess-proof",
          },
        });
        expect(shown.history).toEqual([
          expect.objectContaining({
            jobId: "job-subprocess-proof",
            to: "waiting",
            actor: "tests",
            revision: 0,
            disposition: expect.objectContaining({
              kind: "notify_and_schedule",
              nextWakeAt: 900,
            }),
          }),
        ]);
      } finally {
        resetDurableJobRegistryForTests();
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });
});
