import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { completeUpdateCandidatePluginRehearsal } from "./update-candidate-plugin-repair.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("snapshots retained import.meta and records a named parse warning shared with Doctor", async () => {
  const root = dirs.make("candidate-snapshot-plugin-inspection-");
  const stateDir = path.join(root, "state");
  const candidateRoot = path.join(root, "candidate");
  const plugin = path.join(stateDir, "extensions", "esm-fixture");
  const shared = path.join(stateDir, "extensions", "shared");
  await fs.mkdir(candidateRoot);
  await fs.mkdir(plugin, { recursive: true });
  await fs.mkdir(shared);
  await fs.writeFile(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
  await materializeUpdateCandidateStateWorker(candidateRoot);
  await fs.writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "esm-fixture",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({
      id: "esm-fixture",
      configSchema: { type: "object" },
      doctorContract: { configRepair: true },
    }),
  );
  const entry = `\n\n\n\n\n\nconst padding = "${"x".repeat(724_000)}"; const directory = import.meta.dir; const invalid = /(/;`;
  await fs.writeFile(path.join(plugin, "index.js"), entry);
  await fs.writeFile(
    path.join(plugin, "doctor-contract-api.mjs"),
    'const directory = import.meta.dir; import "../shared/dependency.mjs"; export const legacyConfigRules = [];',
  );
  await fs.writeFile(
    path.join(shared, "dependency.mjs"),
    'throw new Error("inspection must not execute plugin code");',
  );
  const env = {
    ...process.env,
    HOME: root,
    TMPDIR: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const snapshot = await prepareUpdateCandidateStateSnapshot({
    config: { plugins: { load: { paths: [plugin] } } },
    stateDir,
    candidateRoot,
    env,
    workerEnv: (directory) => ({ ...env, ...buildUpdateRehearsalPathEnv(directory) }),
  });
  try {
    const copied = snapshot.pluginPaths[plugin]!;
    expect(await fs.readFile(path.join(copied, "index.js"), "utf8")).toBe(entry);
    expect(snapshot.snapshotWarnings).toEqual([
      expect.stringMatching(/plugin esm-fixture .*Invalid regular expression/),
    ]);
    expect(await fs.readFile(path.resolve(copied, "../shared/dependency.mjs"), "utf8")).toContain(
      "inspection must not execute",
    );
    const doctor = await completeUpdateCandidatePluginRehearsal({
      config: { plugins: { load: { paths: [copied] } } },
      candidateRoot,
      env: {
        ...env,
        ...buildUpdateRehearsalPathEnv(snapshot.stateDir),
        ...buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          serviceRepairPolicy: "external",
          deferConfiguredPluginInstallRepair: true,
        }),
      },
    });
    expect(doctor.warnings).toEqual([
      expect.stringMatching(/plugin esm-fixture .*Invalid regular expression/),
    ]);
    expect(await fs.readFile(path.join(plugin, "index.js"), "utf8")).toBe(entry);
  } finally {
    for (const directory of snapshot.cleanupDirectories) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
