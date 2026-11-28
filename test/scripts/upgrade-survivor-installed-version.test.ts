import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readUpgradeSurvivorPaths } from "./upgrade-survivor-paths.test-support.js";
import {
  readJson,
  readJsonLines,
  runProcess,
  writeExecutable,
  writeJson,
} from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const runner = resolve("scripts/e2e/lib/upgrade-survivor/run.sh");
const baselineVersion = "2026.7.1-2";
const candidateVersion = "2026.8.1";
function installedFixture(version: string) {
  const home = tempDirs.make("survivor-installed-version-");
  const paths = readUpgradeSurvivorPaths(home);
  const state = join(home, "state");
  const tmp = join(home, "tmp");
  const calls = join(home, "calls");
  for (const directory of [state, tmp, paths.packageRoot, paths.binDir]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(calls, "");
  writeJson(join(paths.packageRoot, "package.json"), { name: "openclaw", version });
  const run = (phases: string, env: NodeJS.ProcessEnv, timeout?: number) => {
    const prelude = join(home, "bash-env");
    writeFileSync(
      prelude,
      `install_fixture_phases() {
  trap - DEBUG
  phase() {
    CURRENT_PHASE="$1"
    shift
    ${phases}
  }
}
trap 'case "$BASH_COMMAND" in "phase "*) install_fixture_phases ;; esac' DEBUG
`,
    );
    return runProcess(
      "bash",
      [runner],
      {
        PATH: `${dirname(testNodeExecPath)}:/usr/bin:/bin`,
        HOME: home,
        ...paths.env,
        BASH_ENV: prelude,
        ...env,
      },
      timeout,
    );
  };
  return { home, paths, state, tmp, calls, run };
}

type UpdateFault = [state: string, installed: string | null, exit: number, target?: string];

describe.skipIf(process.platform === "win32")(
  "survivor installed version during admission and after update failure",
  () => {
    it.each([
      ["2026.5.31", "2026.5.31", [], false],
      ["latest", "2026.5.31", ["npm"], false],
      ["latest", "2026.6.1", ["npm", "--version"], true],
    ] as const)(
      "admits %s resolved to %s before running the baseline",
      (requested, installed, expectedCalls, accepted) => {
        const { paths, calls, run } = installedFixture(installed);
        writeExecutable(
          join(paths.binDir, "npm"),
          '#!/bin/sh\nprintf "npm\\n" >> "$FIXTURE_CALLS"\n',
        );
        writeExecutable(
          join(paths.binDir, "openclaw"),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FIXTURE_CALLS"\nprintf '%s\\n' '${installed}'\n`,
        );
        // Exercise the real install/admission phase with inert package-manager and CLI boundaries.
        const result = run(
          `
  trap - DEBUG EXIT ERR
    if [ "$CURRENT_PHASE" = install-baseline ]; then
      "$@"
      exit 0
    fi
`,
          {
            FIXTURE_CALLS: calls,
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE: requested,
          },
        );
        expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
        expect(readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)).toEqual(
          expectedCalls,
        );
        if (!accepted) {
          expect(result.stderr).toContain("Upgrade pre-June installs through OpenClaw 2026.9.5");
        }
      },
    );

    it.each<UpdateFault>([
      ["not-started", baselineVersion, 17],
      ["swapped", candidateVersion, 1],
      ["missing", null, 42],
      ["broken", null, 43],
      ["unchanged", baselineVersion, 44],
      ["future-swapped", "2026.9.99-first-hop.0", 1, "2026.9.99-first-hop.0"],
    ])(
      "reports %s package bytes (%s) and preserves exit %s",
      (packageState, installedVersion, exitCode, target) => {
        const { home, paths, state, tmp, calls, run } = installedFixture(baselineVersion);
        const redactor = join(home, "redactor.mjs");
        // Unit diagnostics use the current source owner without loading a built SDK graph.
        writeFileSync(
          redactor,
          `import { tsImport } from ${JSON.stringify(resolve("node_modules/tsx/dist/esm/api/index.mjs"))};
export const { redactSensitiveText } = await tsImport(${JSON.stringify(resolve("src/logging/redact.ts"))}, import.meta.url);
`,
        );
        const entrypoint = join(paths.packageRoot, "openclaw.mjs");
        const targetVersion = target ?? candidateVersion;
        const beforeUpdate = packageState === "not-started";
        const failurePhase = beforeUpdate ? "install-baseline" : "update-candidate";
        const targetPackage = join(home, target ? "future.tgz" : "candidate.tgz");
        // Inject the package-swap/finalization fault at the executable boundary.
        // The real update owner, package reader, assertions and exit summary still run.
        writeExecutable(
          entrypoint,
          `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, 'calls'), JSON.stringify(args) + '\\n');
if (args[0] === 'update') {
  const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json');
  const packageState = ${JSON.stringify(packageState)};
  if (packageState === 'missing') {
    fs.unlinkSync(manifest);
  } else if (packageState !== 'unchanged') {
    const bytes = packageState === 'broken' ? '{' : JSON.stringify({name:'openclaw', version:${JSON.stringify(targetVersion)}});
    fs.writeFileSync(manifest + '.next', bytes);
    fs.renameSync(manifest + '.next', manifest);
  }
  console.log(JSON.stringify({
    status:'error', mode:'npm', reason:'openclaw doctor',
    before:{version:${JSON.stringify(baselineVersion)}},
    after:{version:${JSON.stringify(targetVersion)}},
    steps:[{name:'global update',exitCode:0},{name:'global install swap',exitCode:0},{name:'openclaw doctor',exitCode:${exitCode}}]
  }));
  console.error('target Doctor fixture failed');
  process.exitCode = ${exitCode};
} else {
  console.error('fixture CLI probe unavailable');
  process.exitCode = 45;
}
`,
        );
        symlinkSync(entrypoint, join(paths.binDir, "openclaw"));
        const result = run(
          `
    case "$CURRENT_PHASE" in
      install-baseline)
        normalize_baseline
        installed_version="$(read_installed_version)"
        ${beforeUpdate ? `return ${exitCode}` : ""}
        ;;
      resolve-candidate) candidate_version=${candidateVersion} ;;
      update-candidate) ${target ? `update_candidate 0 "file:${targetPackage}" "${targetVersion}"` : '"$@"'} ;;
    esac
`,
          {
            USERPROFILE: home,
            OPENCLAW_HOME: home,
            OPENCLAW_STATE_DIR: state,
            OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
            OPENCLAW_E2E_REDACTOR_MODULE: redactor,
            TMPDIR: tmp,
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE: `openclaw@${baselineVersion}`,
            OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC: join(home, "candidate.tgz"),
          },
          15_000,
        );
        expect(result.status, result.stderr).toBe(exitCode);
        const summary = readJson(paths.summaryJson);
        expect(summary).toMatchObject({
          status: "failed",
          updateOutcome: beforeUpdate ? "unknown" : "failed",
          installedVersion,
          baseline: { version: baselineVersion },
          failure: {
            phase: failurePhase,
            message: `phase ${failurePhase} failed with status ${exitCode}`,
          },
        });
        const diagnostics = readJson(join(paths.artifactRoot, "diagnostics", "raw.json"));
        expect(diagnostics).toMatchObject({
          phase: failurePhase,
          exitStatus: exitCode,
        });
        if (beforeUpdate) {
          expect(diagnostics.logs["update.json"]).toBeNull();
          return;
        }
        expect(readFileSync(paths.updateErr, "utf8")).toContain("target Doctor fixture failed");
        const observedCalls = readJsonLines<string[]>(calls);
        // Keep the existing failure probe; version discovery must add no CLI calls.
        expect(observedCalls.map((args) => args[0])).toEqual(["update", "config"]);
        const update = observedCalls[0];
        expect(update?.slice(update.indexOf("--tag"), update.indexOf("--tag") + 2)).toEqual([
          "--tag",
          `file:${targetPackage}`,
        ]);
        expect(observedCalls[1]).toEqual(["config", "validate", "--json"]);
      },
    );
  },
);
