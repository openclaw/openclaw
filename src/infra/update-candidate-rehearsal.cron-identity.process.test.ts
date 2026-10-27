import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function runCronIdentitySupport(args: string[] = [], baseEnv?: NodeJS.ProcessEnv) {
  const worker = new URL(
    "./update-candidate-rehearsal.cron-identity.test-support.ts",
    import.meta.url,
  );
  return runCommandBuffered([process.execPath, ...resolveRuntimeWorkerArgv(worker), ...args], {
    ...(baseEnv ? { baseEnv } : {}),
    timeoutMs: 30_000,
    killGraceMs: 500,
    maxOutputBytes: { stdout: 20_000, stderr: 20_000 },
  });
}

async function prepareSource(root: string, storeKeys: readonly string[]) {
  const stateDir = path.join(root, "source-state");
  const result = await runCronIdentitySupport(["seed", JSON.stringify({ stateDir, storeKeys })]);
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
  const result = await runCronIdentitySupport([], {
    ...env,
    OPENCLAW_UPDATE_IN_PROGRESS: "0",
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
  kind: "default-state" | "explicit-state" | "custom-config",
  storeKeys: (paths: { expected: string; sibling: string }) => readonly string[],
) {
  const root = tempDirs.make("rehearsal-cron-identity-");
  const candidateRoot = path.join(root, "candidate");
  await fs.mkdir(candidateRoot);
  await materializeUpdateCandidateStateWorker(candidateRoot);
  const stateDir = path.join(root, "source-state");
  const customConfigPath = path.join(root, "custom", "openclaw.json");
  const expected =
    kind === "default-state" || kind === "explicit-state"
      ? path.join(stateDir, "cron", "jobs.json")
      : path.join(path.dirname(customConfigPath), "cron", "jobs.json");
  const sibling =
    kind === "default-state" || kind === "explicit-state"
      ? path.join(root, "retained-sibling", "cron", "jobs.json")
      : path.join(stateDir, "cron", "jobs.json");
  const source = await prepareSource(root, storeKeys({ expected, sibling }));
  const sourceBytes = await fs.readFile(source.databasePath);
  const sourceEnv =
    kind === "default-state"
      ? {}
      : kind === "explicit-state"
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

it.each(["default-state", "explicit-state", "custom-config"] as const)(
  "carries the original %s cron identity through the first private admission",
  async (kind) => {
    const fixture = await prepareFixture(kind, ({ expected, sibling }) => [expected, sibling]);
    try {
      const result = await runFirstPrivateAdmission(fixture.rehearsal.env);
      expect(result.initializationCronDefaultStoreKey).toBe(
        path.join(fixture.rehearsal.stateDir, "cron", "jobs.json"),
      );
      expect(result.boundStoreKey).toBe(fixture.expected);
    } finally {
      await cleanupFixture(fixture);
    }
  },
);

it("does not bind an unmatched original identity to a retained sibling", async () => {
  const fixture = await prepareFixture("custom-config", ({ sibling }) => [sibling]);
  try {
    const result = await runFirstPrivateAdmission(fixture.rehearsal.env);
    expect(result.initializationCronDefaultStoreKey).toBe(
      path.join(fixture.rehearsal.stateDir, "cron", "jobs.json"),
    );
    expect(result.boundStoreKey).toBeUndefined();
  } finally {
    await cleanupFixture(fixture);
  }
});
