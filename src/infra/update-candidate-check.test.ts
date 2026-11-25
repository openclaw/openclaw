import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { checkUpdateCandidate } from "./update-candidate-check.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

async function candidate(worker?: string) {
  const root = await fs.realpath(dirs.make("candidate-check-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  if (worker !== undefined) {
    const entry = path.join(
      root,
      "dist",
      runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
    );
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, worker);
  }
  return { root, stateDir: path.join(root, "state"), env: { HOME: root } };
}

it("reads the candidate's update contract from its recovery runtime", async () => {
  const params = await candidate(`
if (process.argv[2] !== "--check") process.exit(9);
process.stdout.write(JSON.stringify({
  doctorConfigWrites: "pid-start-v1", gatewayRestartCompletion: true, state: 41, agent: 42,
}));
`);

  const result = await checkUpdateCandidate(params);

  expect(result).toEqual({
    status: "ok",
    steps: [expect.objectContaining({ name: "candidate-recovery", exitCode: 0 })],
    candidateSchemaVersions: { state: 41, agent: 42 },
    gatewayRestartCompletion: true,
    doctorConfigWrites: true,
  });
});

it.each([
  [
    "a runtime that cannot load",
    `console.error("Cannot find module './daemon-cli.js'"); process.exit(1);`,
  ],
  ["a contract without database versions", `process.stdout.write("{}");`],
])("refuses %s before anything changes", async (_name, worker) => {
  const params = await candidate(worker);

  const result = await checkUpdateCandidate(params);

  expect(result.status).toBe("error");
  expect(result.candidateSchemaVersions).toBeUndefined();
  expect(result.steps).toEqual([
    expect.objectContaining({
      name: "candidate-recovery",
      exitCode: 1,
      failureFacts: [expect.objectContaining({ code: "candidate-runtime-failed" })],
    }),
  ]);
});

it("lets older candidates without the runtime finish through the installed updater", async () => {
  const params = await candidate();

  await expect(checkUpdateCandidate(params)).resolves.toEqual({
    status: "ok",
    steps: [
      expect.objectContaining({
        exitCode: null,
        advisory: expect.objectContaining({ kind: "candidate-runtime-unavailable" }),
      }),
    ],
  });
  await expect(checkUpdateCandidate({ ...params, requireRuntime: true })).resolves.toMatchObject({
    status: "error",
  });
});
