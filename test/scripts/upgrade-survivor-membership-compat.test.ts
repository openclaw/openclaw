import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const flag = "OPENCLAW_FROZEN_UPGRADE_SURVIVOR_MEMBERSHIP_MODE";
const terminalOwner = "src/cli/update-cli/update-command-terminal-publication.ts";
const message = "Service membership unverifiable on this host; using managed stop/update/start.";
const wrapper = readFileSync("scripts/e2e/upgrade-survivor-docker.sh", "utf8");
const selection = wrapper.slice(
  wrapper.indexOf("UPGRADE_SCENARIO_ARGS=()"),
  wrapper.indexOf('if [ "$UPGRADE_TARGET_TRAIN" = extended-stable ]; then'),
);
const runner = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
const recovery = runner.slice(
  runner.indexOf("repair_update_restart_auth()"),
  runner.indexOf("\nrepair_fixture_plugin_consent()"),
);

function target(current: boolean, incomplete = false) {
  const root = temps.make("survivor-membership-");
  const selected = join(root, "selected");
  mkdirSync(dirname(join(selected, terminalOwner)), { recursive: true });
  writeFileSync(
    join(selected, "package.json"),
    JSON.stringify({ version: current ? "2026.9.6" : "2026.9.7" }),
  );
  const owner = current
    ? readFileSync(terminalOwner, "utf8")
    : "export function completeUpdateCommandResult(params, result) { return result; }\n";
  writeFileSync(
    join(selected, terminalOwner),
    incomplete ? owner.replace(message, "changed message") : owner,
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", selected, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "membership fixture\n\nCo-authored-by: RomneyDa <6581799+RomneyDa@users.noreply.github.com>",
  );
  const sha = git("rev-parse", "HEAD");
  const select = (extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      "bash",
      [
        "-c",
        [
          'set -euo pipefail; source "$HARNESS_ROOT_DIR/scripts/lib/frozen-target-compat.sh"',
          selection,
          'printf "%s\\n" "${UPGRADE_COMPAT_ENV_ARGS[@]}"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: root,
          HARNESS_ROOT_DIR: resolve("."),
          ROOT_DIR: selected,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_SELECTED_SHA: sha,
          OPENCLAW_TOOLING_SHA: "a".repeat(40),
          ...extra,
        },
      },
    );
  return { root, selected, select };
}

function runRecovery(
  root: string,
  mode: string,
  receipt: "none" | "valid" | "wrong-run" | "missing-history" = "none",
  failAt = "",
) {
  const result = {
    status: "ok",
    runId: "fixture-run",
    steps:
      receipt === "none"
        ? []
        : [
            {
              name: "managed-service-membership",
              exitCode: 0,
              advisory: { kind: "recoverable-maintenance", message },
            },
          ],
  };
  const status = {
    lastRun: {
      runId: receipt === "wrong-run" ? "other-run" : "fixture-run",
      steps:
        receipt === "none" || receipt === "missing-history"
          ? []
          : [{ step: "warning:managed-service-membership", status: "completed", detail: message }],
    },
  };
  writeFileSync(join(root, "recovery-update.json"), JSON.stringify(result));
  writeFileSync(join(root, "status.json"), JSON.stringify(status));
  const events = join(root, "events");
  writeFileSync(events, "");
  const observed = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        recovery,
        "SCENARIO=base; UPDATE_RESTART_MODE=auto-auth; COMMAND_TIMEOUT=1; update_repair_required=0",
        "restart_fixture_package=fixture.tgz; restart_fixture_version=2100.1.0",
        'phase() { printf "%s\\n" "$1" >> "$EVENTS"; shift; "$@"; }',
        "stop_update_restart_probe_gateway() { :; }",
        "prepare_restart_inference() { :; }; prepare_restart_fixture() { :; }",
        'install_update_restart_systemctl_shim() { printf "containment:%s\\n" "$1" >> "$EVENTS"; }',
        'run_update_restart_probe_gateway() { [ "$1" = start ]; }',
        'check_gateway_status() { [ "$FAIL_AT" != auth ]; }',
        'update_candidate() { [ "$#" -eq 3 ] && [ "$1" = 1 ] && [ "$FAIL_AT" != update ]; }',
        'openclaw_e2e_maybe_timeout() { shift; "$@"; }',
        'openclaw() { [ "$*" = "update status --json" ]; cat "$ARTIFACT_ROOT/status.json"; }',
        'node() { if [ "$1" = --input-type=module ]; then command node "$@"; else [ "$2" = assert-restart-serving-turn ] && [ "$FAIL_AT" != serving ]; fi; }',
        'assert_survival() { [ "$survival_assert_stage" = post-inference ]; printf "survival\\n" >> "$EVENTS"; }',
        "repair_update_restart_auth",
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: root,
        ARTIFACT_ROOT: root,
        EVENTS: events,
        FAIL_AT: failAt,
        [flag]: mode,
      },
    },
  );
  return { ...observed, events: readFileSync(events, "utf8").trim().split("\n") };
}

function selectedMode(stdout: string) {
  return (
    stdout
      .split("\n")
      .find((line) => line.startsWith(flag + "="))
      ?.slice(flag.length + 1) ?? ""
  );
}

describe.skipIf(process.platform === "win32")("frozen managed membership contract", () => {
  it("retains native-contained recovery for the committed pre-warning target", () => {
    const f = target(false);
    // A dirty working file is not a capability of the frozen commit.
    writeFileSync(join(f.selected, terminalOwner), readFileSync(terminalOwner));
    const selected = f.select();
    expect(selected.status, selected.stderr).toBe(0);
    const run = runRecovery(f.root, selectedMode(selected.stdout));
    expect(run.status, run.stderr).toBe(0);
    expect(selectedMode(selected.stdout)).toBe("native");
    expect(run.events).toEqual([
      "stop-recovery-service",
      "prepare-restart-inference",
      "prepare-restart-fixture",
      "prepare-restart-manager",
      "containment:native",
      "prepare-recovery-service",
      "prepared-gateway-auth",
      "recovery-update-restart",
      "assert-restart-serving-turn",
      "survival",
    ]);
    for (const stage of ["auth", "update", "serving"]) {
      expect(runRecovery(f.root, "native", "none", stage).status).not.toBe(0);
    }
  });

  it("keeps absent-containment recovery and both warning receipts strict for current targets", () => {
    const f = target(true);
    const selected = f.select();
    expect(selected.status, selected.stderr).toBe(0);
    expect(selectedMode(selected.stdout)).toBe("absent");
    const valid = runRecovery(f.root, "absent", "valid");
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.events).toContain("containment:absent");
    expect(valid.events).toContain("recovery-membership-warning");
    expect(valid.events.at(-1)).toBe("survival");
    for (const receipt of ["none", "wrong-run", "missing-history"] as const) {
      const rejected = runRecovery(f.root, "absent", receipt);
      expect(rejected.status).not.toBe(0);
      expect(rejected.events).not.toContain("assert-restart-serving-turn");
    }
    expect(runRecovery(f.root, "", "none").status).not.toBe(0);
    const invalid = runRecovery(f.root, "unsupported", "valid");
    expect(invalid.status).not.toBe(0);
    expect(invalid.events).toEqual([""]);
  });

  it("rejects mismatched identity and partial contracts; unqualified runs stay strict", () => {
    const f = target(true, true);
    expect(f.select().status).not.toBe(0);
    const old = target(false);
    expect(old.select({ OPENCLAW_SELECTED_SHA: "b".repeat(40) }).status).not.toBe(0);
    const current = old.select({
      OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0",
      [flag]: "native",
    });
    expect(current.status, current.stderr).toBe(0);
    expect(selectedMode(current.stdout)).toBe("absent");
  });
});
