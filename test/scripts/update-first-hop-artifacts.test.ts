import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posixIt = process.platform === "win32" ? it.skip : it;

function fixture(override: boolean) {
  const root = tempDirs.make("first-hop-artifacts-");
  const harness = path.join(root, "harness");
  const lib = path.join(harness, "scripts/lib");
  const e2e = path.join(harness, "scripts/e2e");
  mkdirSync(lib, { recursive: true });
  mkdirSync(path.join(e2e, "lib"), { recursive: true });
  const script = path.join(e2e, "update-first-hop-compat-docker.sh");
  copyFileSync("scripts/e2e/update-first-hop-compat-docker.sh", script);
  // Stub package construction and the Docker boundary, not artifact allocation or
  // the preservation oracle. Both real owners run on every wrapper invocation.
  writeFileSync(
    path.join(lib, "docker-e2e-package.sh"),
    `docker_e2e_prepare_package_tgz() { printf '%s\\n' "$TEST_PACKAGE"; }
docker_e2e_cleanup_package_tgz() { :; }
docker_e2e_package_mount_args() { DOCKER_E2E_PACKAGE_ARGS=("-v" "$1:$2:ro"); }
docker_e2e_abs_path() { printf '%s\\n' "$1"; }
`,
  );
  writeFileSync(
    path.join(lib, "docker-e2e-image.sh"),
    `docker_e2e_resolve_image() { printf 'fixture\\n'; }
docker_e2e_build_or_reuse() { :; }
docker_e2e_run_with_harness() {
  printf '%s\\n' "$lane_artifact_dir" >> "$TEST_RUN_LOG"
  mkdir -p "$FIXTURE_ROOT/config"
  printf '%s\\n' '{"gateway":{"mode":"local","reload":{"mode":"off"}},"meta":{"migrations":{"modelPolicyAllowlist":true}}}' > "$FIXTURE_ROOT/config/openclaw.json"
  "$TEST_NODE" "$TEST_ORACLE" seed-skills "$FIXTURE_ROOT/config/openclaw.json" "$lane_artifact_dir"
  "$TEST_NODE" "$TEST_ORACLE" seed "$FIXTURE_ROOT/config/openclaw.json" "$lane_artifact_dir" 2026.9.5
  if [ "\${TEST_REPEAT_CAPTURE:-0}" = 1 ]; then
    "$TEST_NODE" "$TEST_ORACLE" seed-skills "$FIXTURE_ROOT/config/openclaw.json" "$lane_artifact_dir"
  fi
}
`,
  );
  writeFileSync(
    path.join(e2e, "lib/update-first-hop-package-fixtures.mjs"),
    `import fs from 'node:fs';
const [command, source, target] = process.argv.slice(2);
if (command === 'source') console.log('{}');
else fs.copyFileSync(source, target);
`,
  );
  mkdirSync(path.join(root, "package/dist"), { recursive: true });
  writeFileSync(path.join(root, "package/dist/build-info.json"), "{}\n");
  const tarball = path.join(root, "package.tgz");
  const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(pack.error).toBeUndefined();
  expect(pack.status, pack.stderr).toBe(0);
  const artifacts = override
    ? path.join(root, "explicit artifacts")
    : path.join(root, ".artifacts/docker-tests/update-first-hop-compat");
  const log = path.join(root, "runs.txt");
  const env = {
    ...process.env,
    TMPDIR: root,
    GIT_COMMIT: undefined,
    GIT_SHA: undefined,
    UPGRADE_SURVIVOR_PREFIX: undefined,
    UPGRADE_SURVIVOR_LITERAL: undefined,
    OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP: "1",
    OPENCLAW_DOCKER_E2E_REPO_ROOT: root,
    OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR: override ? artifacts : undefined,
    OPENCLAW_UPDATE_FIRST_HOP_SOURCE_PACKAGE_TGZ: tarball,
    TEST_PACKAGE: tarball,
    TEST_RUN_LOG: log,
    TEST_NODE: process.execPath,
    TEST_ORACLE: path.resolve("scripts/e2e/lib/upgrade-survivor/first-hop-config-preservation.mjs"),
  };
  return {
    root,
    artifacts,
    runs: () => readFileSync(log, "utf8").trim().split("\n"),
    run: (repeatCapture = false) =>
      spawnSync("/bin/bash", [script], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...env, TEST_REPEAT_CAPTURE: repeatCapture ? "1" : "0" },
      }),
  };
}

describe("first-hop wrapper artifact custody", () => {
  posixIt("retains distinct default captures across reruns", () => {
    const f = fixture(false);
    const first = f.run();
    expect(first.error).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    const firstDir = f.runs()[0];
    assert(firstDir, "the successful wrapper must record its artifact directory");
    const before = readFileSync(path.join(firstDir, "positive-config-before.json"), "utf8");
    const second = f.run();
    expect(second.error).toBeUndefined();
    expect(second.status, second.stderr).toBe(0);
    const runs = f.runs();
    expect(runs).toHaveLength(2);
    expect(runs[1]).not.toBe(firstDir);
    for (const run of runs) {
      expect(path.dirname(run)).toBe(f.artifacts);
      expect(
        JSON.parse(readFileSync(path.join(run, "positive-config-before.json"), "utf8")),
      ).toMatchObject({ targetVersion: "2026.9.5" });
    }
    expect(readFileSync(path.join(firstDir, "positive-config-before.json"), "utf8")).toBe(before);
    expect(
      readdirSync(f.root).filter((name) => name.startsWith("openclaw-update-first-hop.")),
    ).toEqual([]);
  });

  posixIt("keeps an explicit output path and rejects reuse without overwriting evidence", () => {
    const f = fixture(true);
    const first = f.run();
    expect(first.error).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    expect(f.runs()).toEqual([f.artifacts]);
    const before = readFileSync(path.join(f.artifacts, "positive-config-before.json"), "utf8");
    const second = f.run();
    expect(second.error).toBeUndefined();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("skills must be seeded before the config baseline");
    expect(f.runs()).toEqual([f.artifacts, f.artifacts]);
    expect(readFileSync(path.join(f.artifacts, "positive-config-before.json"), "utf8")).toBe(
      before,
    );
    expect(
      readdirSync(f.root).filter((name) => name.startsWith("openclaw-update-first-hop.")),
    ).toEqual([]);
  });

  posixIt("propagates a within-run capture collision and retains its evidence", () => {
    const f = fixture(true);
    const result = f.run(true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("skills must be seeded before the config baseline");
    expect(f.runs()).toEqual([f.artifacts]);
    expect(
      JSON.parse(readFileSync(path.join(f.artifacts, "positive-config-before.json"), "utf8")),
    ).toMatchObject({ targetVersion: "2026.9.5" });
    expect(
      readdirSync(f.root).filter((name) => name.startsWith("openclaw-update-first-hop.")),
    ).toEqual([]);
  });
});
