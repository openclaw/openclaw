import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertFreshTestboxAdmission,
  boundedTestboxIdleMinutes,
  planTestboxAdmission,
} from "../../scripts/ci-testbox-budget.mjs";

const now = Date.parse("2026-10-01T12:00:00Z");
const request = {
  profile: "check",
  id: "tbx_example",
  createdAt: "2026-10-01T11:55:00Z",
};

describe("Testbox spending admission", () => {
  it("shares one bounded pool across profiles without changing a lease's slot", () => {
    const groups = new Set<string>();
    for (let index = 0; index < 256; index++) {
      const lease = { ...request, id: `tbx_example_${index}` };
      const group = planTestboxAdmission(lease, now).group;
      expect(group).toMatch(/^openclaw-testbox-budget-v1-(?:[0-9]|[12][0-9]|3[01])$/);
      for (const profile of ["arm", "build", "windows"]) {
        expect(planTestboxAdmission({ ...lease, profile }, now).group).toBe(group);
      }
      groups.add(group);
    }
    expect(groups.size).toBe(32);
  });

  it("defaults routine proof to 16-class and requires the high-memory profile for 32-class", () => {
    expect(planTestboxAdmission(request, now).runner).toBe("blacksmith-16vcpu-ubuntu-2404");
    expect(() =>
      planTestboxAdmission({ ...request, runner: "blacksmith-32vcpu-ubuntu-2404" }, now),
    ).toThrow(/not allowed/);
    const groups = new Set<string>();
    for (let index = 0; index < 128; index++) {
      const plan = planTestboxAdmission(
        { ...request, profile: "check-memory", id: `tbx_memory_${index}` },
        now,
      );
      expect(plan.runner).toBe("blacksmith-32vcpu-ubuntu-2404");
      expect(plan.group).toMatch(/^openclaw-testbox-budget-v1-[0-3]$/);
      groups.add(plan.group);
    }
    expect(groups.size).toBe(4);
  });

  it.each([0, -1, 241, 1.5, "invalid"])("rejects an unbounded runtime: %s", (minutes) => {
    expect(() => planTestboxAdmission({ ...request, minutes }, now)).toThrow(/runtime/);
  });

  it("defaults routine proof to one hour and preserves explicit long-proof requests", () => {
    const workflow = parse(readFileSync(".github/workflows/ci-check-testbox.yml", "utf8"));
    const dispatchDefault = workflow.on.workflow_dispatch.inputs.timeout_minutes.default;
    expect(planTestboxAdmission({ ...request, minutes: dispatchDefault }, now).minutes).toBe(60);
    expect(planTestboxAdmission(request, now).minutes).toBe(60);
    expect(planTestboxAdmission({ ...request, minutes: "" }, now).minutes).toBe(60);
    expect(planTestboxAdmission({ ...request, minutes: 30 }, now).minutes).toBe(30);
    expect(planTestboxAdmission({ ...request, profile: "check-memory" }, now).minutes).toBe(240);
    expect(planTestboxAdmission({ ...request, minutes: 240 }, now).minutes).toBe(240);
    expect(() => planTestboxAdmission({ ...request, profile: "build", minutes: 36 }, now)).toThrow(
      /1 to 35/,
    );
    expect(() => planTestboxAdmission({ ...request, profile: "arm", minutes: 121 }, now)).toThrow(
      /1 to 120/,
    );
  });

  it("allows approved Windows sizes and refuses arbitrary dispatch labels", () => {
    for (const size of [8, 16]) {
      const runner = `blacksmith-${size}vcpu-windows-2025`;
      expect(planTestboxAdmission({ ...request, profile: "windows", runner }, now).runner).toBe(
        runner,
      );
    }
    for (const runner of ["self-hosted", "blacksmith-32vcpu-windows-2025"]) {
      expect(() => planTestboxAdmission({ ...request, profile: "windows", runner }, now)).toThrow(
        /not allowed/,
      );
    }
  });

  it("expires abandoned queue entries before hydration, including the deadline itself", () => {
    const plan = planTestboxAdmission(request, now);
    expect(() => assertFreshTestboxAdmission(plan.expires_at, plan.expires_at - 1)).not.toThrow();
    expect(() => assertFreshTestboxAdmission(plan.expires_at, plan.expires_at)).toThrow(/expired/);
    expect(() => planTestboxAdmission(request, plan.expires_at)).toThrow(/expired/);
    expect(() => planTestboxAdmission({ ...request, createdAt: "unknown" }, now)).toThrow(
      /invalid/,
    );
  });

  it.each(["check", "check-memory", "arm", "build", "windows"])(
    "admits a saturated %s queue without resetting the dispatch deadline",
    (profile) => {
      const created = Date.parse(request.createdAt);
      const plan = planTestboxAdmission({ ...request, profile }, created + 35 * 60_000);
      expect(plan.expires_at).toBe(created + 60 * 60_000);
      expect(() => planTestboxAdmission({ ...request, profile }, created + 60 * 60_000)).toThrow(
        /expired/,
      );
    },
  );

  it("caps idle requests while retaining shorter provider deadlines", () => {
    expect(boundedTestboxIdleMinutes("90\n")).toBe(15);
    expect(boundedTestboxIdleMinutes("5\n")).toBe(5);
    expect(() => boundedTestboxIdleMinutes("0")).toThrow(/invalid/);
  });

  it("configures idle time after an admitted checkout crosses the queue deadline", () => {
    const script = resolve("scripts/ci-testbox-budget.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          import { pathToFileURL } from "node:url";
          const read = fs.readFileSync;
          fs.readFileSync = (path, ...args) =>
            path === "/tmp/.testbox/idle_timeout" ? "90\\n" : read(path, ...args);
          fs.writeFileSync = (path, value) => {
            assert.equal(path, "/tmp/.testbox/idle_timeout");
            assert.equal(value, "15\\n");
            console.log("idle setting updated");
          };
          syncBuiltinESMExports();
          process.argv = [process.execPath, ${JSON.stringify(script)}, "configure"];
          await import(pathToFileURL(process.argv[1]).href);
        `,
      ],
      { encoding: "utf8", env: { TESTBOX_EXPIRES_AT: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("idle setting updated");
  });

  it.each([
    ["ci-check-testbox.yml", "check", "check"],
    ["ci-check-high-memory-testbox.yml", "check", "check-memory"],
    ["ci-check-arm-testbox.yml", "check-arm", "arm"],
    ["ci-build-artifacts-testbox.yml", "build-artifacts", "build"],
    ["windows-blacksmith-testbox.yml", "windows", "windows"],
  ])("enforces admission before allocating %s", (file, jobName, profile) => {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    const admission = workflow.jobs.admission;
    const job = workflow.jobs[jobName];
    expect(admission["runs-on"]).toBe("ubuntu-24.04");
    const budget = admission.steps.find((step: { id?: string }) => step.id === "budget");
    expect(budget.run).toBe("node scripts/ci-testbox-budget.mjs admit");
    expect(budget.env.TESTBOX_PROFILE).toBe(profile);
    expect(job.needs).toBe("admission");
    expect(job.if).toContain("needs.admission.result == 'success'");
    expect(job["runs-on"]).toContain("needs.admission.outputs.runner");
    expect(job.concurrency.group).toContain("needs.admission.outputs.group");
    expect(job.concurrency.queue).toBeUndefined();
    expect(job.concurrency["cancel-in-progress"]).toBe(false);
    const names = job.steps.map((step: { name: string }) => step.name);
    expect(names.indexOf("Reject expired Testbox admission")).toBeGreaterThan(
      names.indexOf("Begin Testbox"),
    );
    expect(names.indexOf("Reject expired Testbox admission")).toBeLessThan(
      names.indexOf("Checkout"),
    );
    if (profile !== "windows") {
      expect(names.indexOf("Bound Testbox idle lifetime")).toBeLessThan(
        names.indexOf("Setup Node environment"),
      );
      expect(names).toContain("Close Testbox SSH sessions");
    }
    const expiry = job.steps.find(
      (step: { name: string }) => step.name === "Reject expired Testbox admission",
    );
    const plan = planTestboxAdmission({ ...request, profile }, now);
    const created = Date.parse(request.createdAt);
    for (const minutes of [35, 59, 60]) {
      const result = spawnSync(
        "bash",
        ["-c", `date() { printf '%s\\n' "$TESTBOX_NOW_SECONDS"; }\n${expiry.run}`],
        {
          encoding: "utf8",
          env: {
            TESTBOX_EXPIRES_AT: String(plan.expires_at),
            TESTBOX_NOW_SECONDS: String(created / 1000 + minutes * 60),
          },
        },
      );
      expect(result.status, `${file} at ${minutes} minutes: ${result.stderr}`).toBe(
        minutes < 60 ? 0 : 1,
      );
      if (minutes === 60) {
        expect(result.stderr).toContain("stop this lease and request a fresh one");
      }
    }
  });
});
