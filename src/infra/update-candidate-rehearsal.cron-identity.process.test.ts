import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";
import { UPDATE_REHEARSAL_CRON_IDENTITY_ENV } from "./update-rehearsal-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function prepareSource(root: string, storeKeys: readonly string[]) {
  const stateDir = path.join(root, "source-state");
  const worker = new URL(
    "./update-candidate-rehearsal.cron-identity.test-support.ts",
    import.meta.url,
  );
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(worker),
      "seed",
      JSON.stringify({ stateDir, storeKeys }),
    ],
    {
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 20_000, stderr: 20_000 },
    },
  );
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  const line = result.stdout
    .toString("utf8")
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith("CRON_IDENTITY_SEED "));
  expect(line).toBeDefined();
  const { databasePath } = JSON.parse(line!.slice("CRON_IDENTITY_SEED ".length)) as {
    databasePath: string;
  };
  return { stateDir, databasePath };
}

async function runFirstPrivateAdmission(env: NodeJS.ProcessEnv) {
  const worker = new URL(
    "./update-candidate-rehearsal.cron-identity.test-support.ts",
    import.meta.url,
  );
  const result = await runCommandBuffered([process.execPath, ...resolveRuntimeWorkerArgv(worker)], {
    baseEnv: { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "0" },
    timeoutMs: 30_000,
    killGraceMs: 500,
    maxOutputBytes: { stdout: 20_000, stderr: 20_000 },
  });
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  const line = result.stdout
    .toString("utf8")
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith("CRON_IDENTITY_RESULT "));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("CRON_IDENTITY_RESULT ".length)) as {
    initializationCronDefaultStoreKey?: string;
    boundStoreKey?: string;
  };
}

async function prepareFixture(
  kind: "explicit-state" | "custom-config",
  storeKeys: (paths: { expected: string; sibling: string }) => readonly string[],
) {
  const root = tempDirs.make("rehearsal-cron-identity-");
  const candidateRoot = path.join(root, "candidate");
  await fs.mkdir(candidateRoot);
  await materializeUpdateCandidateStateWorker(candidateRoot);
  const stateDir = path.join(root, "source-state");
  const customConfigPath = path.join(root, "custom", "openclaw.json");
  const expected =
    kind === "explicit-state"
      ? path.join(stateDir, "cron", "jobs.json")
      : path.join(path.dirname(customConfigPath), "cron", "jobs.json");
  const sibling =
    kind === "explicit-state"
      ? path.join(root, "retained-sibling", "cron", "jobs.json")
      : path.join(stateDir, "cron", "jobs.json");
  const source = await prepareSource(root, storeKeys({ expected, sibling }));
  const sourceBytes = await fs.readFile(source.databasePath);
  const sourceEnv =
    kind === "explicit-state"
      ? { OPENCLAW_STATE_DIR: source.stateDir, OPENCLAW_CONFIG_PATH: "/ignored/openclaw.json" }
      : { OPENCLAW_CONFIG_PATH: customConfigPath };
  const rehearsal = await prepareUpdateCandidateRehearsal({
    config: {},
    candidateRoot,
    stateDir: source.stateDir,
    env: sourceEnv,
  });
  return { expected, sibling, source, sourceBytes, rehearsal };
}

async function cleanupFixture(fixture: Awaited<ReturnType<typeof prepareFixture>>) {
  const privateRoot = fixture.rehearsal.stateDir;
  await fixture.rehearsal.cleanup();
  await expect(fs.stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(fixture.source.databasePath)).toEqual(fixture.sourceBytes);
}

it.each(["explicit-state", "custom-config"] as const)(
  "carries the original %s cron identity through the first private admission",
  async (kind) => {
    const fixture = await prepareFixture(kind, ({ expected, sibling }) => [expected, sibling]);
    try {
      await expect(runFirstPrivateAdmission(fixture.rehearsal.env)).resolves.toEqual({
        initializationCronDefaultStoreKey: fixture.expected,
        boundStoreKey: fixture.expected,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  },
);

it("does not bind an unmatched original identity to a retained sibling", async () => {
  const fixture = await prepareFixture("custom-config", ({ sibling }) => [sibling]);
  try {
    await expect(runFirstPrivateAdmission(fixture.rehearsal.env)).resolves.toEqual({
      initializationCronDefaultStoreKey: fixture.expected,
    });
  } finally {
    await cleanupFixture(fixture);
  }
});

it("keeps missing older-parent provenance unresolved instead of guessing", async () => {
  const fixture = await prepareFixture("custom-config", ({ expected, sibling }) => [
    expected,
    sibling,
  ]);
  delete fixture.rehearsal.env[UPDATE_REHEARSAL_CRON_IDENTITY_ENV];
  try {
    await expect(runFirstPrivateAdmission(fixture.rehearsal.env)).resolves.toEqual({
      initializationCronDefaultStoreKey: path.join(fixture.rehearsal.stateDir, "cron", "jobs.json"),
    });
  } finally {
    await cleanupFixture(fixture);
  }
});
