import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  prepareReadinessHandoff,
  inspectReadinessHandoff,
} from "../../scripts/e2e/lib/upgrade-survivor/repair-readiness-handoff.mjs";
import { readWorkerCellPackageIdentity } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

// OS ancestry and Node preload argv/env cannot be established by mocked RPCs.
// These tiny processes qualify the observer, never the packaged Gateway itself.
it.skipIf(process.platform !== "linux")(
  "records only actual handoffs without supplying markers or accepting changed entries",
  () => {
    for (const mode of ["present", "missing", "tampered"]) {
      const root = dirs.make("readiness-handoff-");
      const artifacts = join(root, "artifacts");
      const pkg = join(root, "package");
      mkdirSync(artifacts);
      mkdirSync(join(pkg, "dist"), { recursive: true });
      mkdirSync(join(pkg, "scripts"));
      const workerRelative =
        "dist/" + runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath;
      const worker = join(pkg, workerRelative);
      mkdirSync(dirname(worker), { recursive: true });
      writeFileSync(worker, 'process.stdout.write("candidate output preserved");');
      writeFileSync(
        join(pkg, "scripts/postinstall.mjs"),
        'process.stdout.write("npm lifecycle preserved");',
      );
      const candidateBuild = { version: "2026.10.1", commit: "2".repeat(40) };
      const driverSource = [
        'import fs from "node:fs"; import path from "node:path"; import { spawnSync } from "node:child_process";',
        "const root = path.dirname(fs.realpathSync(process.argv[1]));",
        'const run = (file, args, env) => { const r = spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); process.stdout.write(r.stdout); };',
        'run(path.join(root, "scripts/postinstall.mjs"), [], process.env);',
        'fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.10.1" }));',
        'fs.writeFileSync(path.join(root, "dist/build-info.json"), ' +
          JSON.stringify(JSON.stringify(candidateBuild)) +
          ");",
        "const worker = path.join(root, " + JSON.stringify(workerRelative) + ");",
        'run(worker, ["--check"], process.env);',
        'run(worker, ["--doctor"], process.env);',
        'if (process.argv[3] === "tampered") fs.appendFileSync(worker, "/* changed payload */");',
        "const env = { ...process.env }; delete env.OPENCLAW_UPDATE_IN_PROGRESS;",
        'if (process.argv[3] !== "missing") env.OPENCLAW_UPDATE_IN_PROGRESS = "1";',
        'run(worker, ["--post-core"], env);',
        "run(worker, [], env);",
      ].join("\n");
      writeFileSync(join(pkg, "openclaw.mjs"), driverSource);
      const writeIdentity = (version: string, commit: string) => {
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "openclaw", version }));
        writeFileSync(join(pkg, "dist/build-info.json"), JSON.stringify({ version, commit }));
        return readWorkerCellPackageIdentity(pkg);
      };
      const candidate = writeIdentity(candidateBuild.version, candidateBuild.commit);
      const baseline = writeIdentity("2026.9.7", "1".repeat(40));
      prepareReadinessHandoff({ artifacts, packageRoot: pkg, baseline, candidate });
      const cli = join(root, "openclaw");
      symlinkSync(join(pkg, "openclaw.mjs"), cli);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_OPTIONS:
          "--import=" + resolve("scripts/e2e/lib/upgrade-survivor/repair-readiness-handoff.mjs"),
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
      };
      delete env.OPENCLAW_UPDATE_IN_PROGRESS;
      const result = spawnSync(resolveTestNodeExecPath(), [cli, "update", mode], {
        env,
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        "npm lifecycle preserved" + "candidate output preserved".repeat(4),
      );
      if (mode === "present") {
        const witness = inspectReadinessHandoff({ artifacts, driverPid: result.pid });
        expect(witness.driver.marker).toBe(false);
        expect(witness.candidates).toHaveLength(2);
        for (const observation of witness.candidates) {
          expect(observation).toMatchObject({
            marker: true,
            entry: workerRelative,
            commit: candidateBuild.commit,
          });
        }
        expect(() => inspectReadinessHandoff({ artifacts, driverPid: result.pid + 1 })).toThrow(
          "released updater was not observed",
        );
        expect(readFileSync(join(pkg, "openclaw.mjs"), "utf8")).toBe(driverSource);
        const sibling = spawnSync(resolveTestNodeExecPath(), [worker, "--post-core"], {
          env: { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(sibling.status, sibling.stderr).toBe(0);
        expect(() => inspectReadinessHandoff({ artifacts, driverPid: result.pid })).toThrow(
          "not descended from the launched released updater",
        );
      } else {
        expect(() => inspectReadinessHandoff({ artifacts, driverPid: result.pid })).toThrow(
          mode === "missing" ? "did not propagate" : "observation failed",
        );
      }
    }
  },
);
