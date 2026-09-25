import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertLegacyOperatorGatewayState,
  seedLegacyOperatorDefaultCron,
  seedLegacyOperatorGatewayState,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-state.mjs";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
const originalChildProcess =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");
const dirs = useAutoCleanupTempDirTracker(afterEach);
const jobs = [
  { id: "main-job", name: "survivor-default-owner", effectiveAgentId: "main" },
  { id: "ops-job", name: "survivor-ops-owner", agentId: "ops", effectiveAgentId: "ops" },
];
const entries = jobs.map((job, index) => ({
  jobId: job.id,
  action: "finished",
  ts: 200 + index,
  runAtMs: 100 + index,
  runId: `published-run-${index}`,
  status: "ok",
  summary: `published output ${index}`,
}));
const page = (values: typeof entries, total = values.length, offset = 0) => ({
  entries: values,
  total,
  offset,
  limit: 1,
  hasMore: false,
  nextOffset: null,
});
const reply = (value: unknown) => ({
  pid: 1,
  output: [],
  status: 0,
  signal: null,
  stdout: JSON.stringify(value),
  stderr: "",
});
beforeEach(() => {
  vi.mocked(spawnSync).mockReset().mockImplementation(originalChildProcess.spawnSync);
});
afterEach(() => {
  vi.mocked(spawnSync).mockImplementation(originalChildProcess.spawnSync);
});

it.each(["2026.9.4", "2026.9.6"])(
  "seeds native run rows only through the %s CLI",
  async (version) => {
    const root = dirs.make("survivor-cron-reader-seed-");
    const baselinePath = path.join(root, "legacy-operator-baseline.json");
    fs.writeFileSync(baselinePath, "{}");
    const ran = new Set<string>();
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      if (command !== "openclaw") {
        return originalChildProcess.spawnSync(command, args, options);
      }
      if (!Array.isArray(args)) {
        throw new Error("CLI arguments missing");
      }
      if (args[1] === "add") {
        expect(args.includes("--no-deliver")).toBe(version === "2026.9.6");
        return reply(jobs.find((job) => job.name === args[args.indexOf("--name") + 1]));
      }
      if (args[1] === "run") {
        expect(args).toEqual(["cron", "run", args[2], "--wait"]);
        ran.add(args[2]);
        return reply({ ok: true });
      }
      expect(args[1]).toBe("runs");
      const id = args[args.indexOf("--id") + 1];
      expect(ran.has(id)).toBe(true);
      return reply(page(entries.filter((entry) => entry.jobId === id)));
    });
    await withEnvAsync(
      {
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root,
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: version,
      },
      async () => {
        seedLegacyOperatorDefaultCron();
        seedLegacyOperatorGatewayState();
      },
    );
    const saved = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    expect(saved.jobs).toHaveLength(2);
    if (version === "2026.9.6") {
      expect([...ran]).toEqual(["main-job", "ops-job"]);
      expect(saved.jobs.flatMap((job: { history: unknown[] }) => job.history)).toEqual(entries);
    } else {
      expect([...ran]).toEqual([]);
      expect(saved.jobs.every((job: { history?: unknown[] }) => job.history === undefined)).toBe(
        true,
      );
    }
  },
);

it.each([
  { source: "native", damage: "none" },
  { source: "legacy", damage: "none" },
  { source: "updater", damage: "none" },
  { source: "native", damage: "content" },
  { source: "legacy", damage: "missing-filter" },
  { source: "native", damage: "offset" },
])("checks candidate Cron pages for $source history ($damage)", async ({ source, damage }) => {
  const root = dirs.make("survivor-cron-reader-check-");
  fs.writeFileSync(
    path.join(root, "legacy-operator-baseline.json"),
    JSON.stringify({
      jobs: jobs.map((job, index) => ({
        ...job,
        ...(source === "native" ? { history: [entries[index]] } : {}),
      })),
    }),
  );
  const contract =
    source === "updater" ? "published-updater-import-preserved" : "candidate-doctor-import";
  if (source !== "native") {
    fs.writeFileSync(
      path.join(root, "legacy-operator-cron-history.json"),
      JSON.stringify({ entries }),
    );
    fs.writeFileSync(
      path.join(root, "legacy-operator-cron-history-proof.json"),
      JSON.stringify({ status: "passed", contract }),
    );
  }
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    if (command !== "openclaw") {
      return originalChildProcess.spawnSync(command, args, options);
    }
    if (!Array.isArray(args)) {
      throw new Error("CLI arguments missing");
    }
    if (args[1] === "list") {
      return reply({ jobs });
    }
    expect(args.slice(0, 2)).toEqual(["cron", "runs"]);
    const selected = entries.filter((entry) => entry.jobId === args[args.indexOf("--id") + 1]);
    if (args.includes("--offset")) {
      return reply(page([], damage === "offset" ? 0 : 1, 1));
    }
    if (args.includes("missing-survivor-run")) {
      return reply(page(damage === "missing-filter" ? selected : []));
    }
    return reply(
      page(
        damage === "content"
          ? selected.map((entry) => ({ ...entry, summary: "changed" }))
          : selected,
      ),
    );
  });
  await withEnvAsync({ OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root }, async () => {
    if (damage === "none") {
      expect(() => assertLegacyOperatorGatewayState("candidate")).not.toThrow();
    } else {
      expect(() => assertLegacyOperatorGatewayState("candidate")).toThrow();
    }
  });
  const proof = JSON.parse(
    fs.readFileSync(path.join(root, "legacy-operator-candidate-cron-history.json"), "utf8"),
  );
  expect(proof.status).toBe(damage === "none" ? "passed" : "failed");
  expect(proof.source).toBe(source === "native" ? "published-native-runs" : contract);
  if (damage === "none") {
    expect(proof.pages).toHaveLength(2);
  }
});
