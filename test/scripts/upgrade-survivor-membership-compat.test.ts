import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const flag = "OPENCLAW_FROZEN_UPGRADE_SURVIVOR_MEMBERSHIP_MODE";
const terminalOwner = "src/cli/update-cli/update-command-terminal-publication.ts";
const message = "Service membership unverifiable on this host; using managed stop/update/start.";
const warning = {
  name: "managed-service-membership",
  exitCode: 0,
  advisory: { kind: "recoverable-maintenance", message },
};
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
  writeJson(join(selected, "package.json"), { version: current ? "2026.9.6" : "2026.9.7" });
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
    runProcess(
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
        PATH: process.env.PATH,
        HOME: root,
        HARNESS_ROOT_DIR: resolve("."),
        ROOT_DIR: selected,
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
        OPENCLAW_SELECTED_SHA: sha,
        OPENCLAW_TOOLING_SHA: "a".repeat(40),
        ...extra,
      },
    );
  return { root, selected, select };
}

function runRecovery(
  root: string,
  mode: string,
  receipt: "none" | "valid" | "wrong-run" | "missing-history" = "none",
  failAt = "",
  resident = false,
  plugins: "completed" | "late" | "failed" | "absent" | "wrong-run" = "completed",
) {
  writeJson(join(root, "package.json"), { version: resident ? "2100.0.0" : "2100.1.0" });
  const pluginStep = {
    step: "plugins",
    status: plugins === "failed" ? "failed" : "completed",
    detail: plugins === "failed" ? "whatsapp: registry unavailable" : undefined,
  };
  writeJson(join(root, "recovery-update.json"), {
    status: "ok",
    runId: "fixture-run",
    steps: receipt === "none" ? [] : [warning],
  });
  const status = (withPlugins: boolean) => ({
    lastRun: {
      runId: receipt === "wrong-run" || plugins === "wrong-run" ? "other-run" : "fixture-run",
      steps: [
        ...(receipt === "none" || receipt === "missing-history"
          ? []
          : [{ step: "warning:managed-service-membership", status: "completed", detail: message }]),
        ...(withPlugins ? [pluginStep] : []),
      ],
    },
  });
  writeJson(
    join(root, "status.json"),
    status(resident && plugins !== "late" && plugins !== "absent"),
  );
  if (resident && plugins === "late") {
    writeJson(join(root, "status.next.json"), status(true));
  }
  const events = join(root, "events");
  writeFileSync(events, "");
  const observed = runProcess(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        recovery,
        runner.slice(
          runner.indexOf("read_installed_version()"),
          runner.indexOf("\nstorage_preflight()"),
        ),
        runner.slice(
          runner.indexOf("assert_survival()"),
          runner.indexOf("\nprobe_gateway_endpoint()"),
        ),
        "SCENARIO=base; UPDATE_RESTART_MODE=auto-auth; COMMAND_TIMEOUT=1; update_repair_required=0",
        "baseline_version=2099.1.0; candidate_version=2100.0.0",
        'package_root() { printf "%s" "$ARTIFACT_ROOT"; }',
        "restart_fixture_package=fixture.tgz; restart_fixture_version=2100.1.0",
        'phase() { printf "%s\\n" "$1" >> "$EVENTS"; shift; "$@"; }',
        "stop_update_restart_probe_gateway() { :; }",
        "prepare_restart_inference() { :; }; prepare_restart_plugin_release_selectors() { :; }; prepare_restart_fixture() { :; }",
        'install_update_restart_systemctl_shim() { printf "containment:%s\\n" "$1" >> "$EVENTS"; }',
        'run_update_restart_probe_gateway() { [ "$1" = start ]; }',
        'check_gateway_status() { [ "$FAIL_AT" != auth ]; }',
        'update_candidate() { [ "$#" -eq 3 ] && [ "$1" = 1 ] && [ "$FAIL_AT" != update ] || return 1; if [ "$RESIDENT" = 1 ]; then last_update_restart_route=resident; fi; }',
        'openclaw_e2e_maybe_timeout() { shift; "$@"; }',
        'openclaw() { if [ "$*" = --version ] && [ "$RESIDENT" = 1 ]; then printf "OpenClaw 2100.1.0 (fixture)\\n"; elif [ "$*" = "update status --json" ]; then cat "$ARTIFACT_ROOT/status.json"; if [ -f "$ARTIFACT_ROOT/status.next.json" ]; then mv "$ARTIFACT_ROOT/status.next.json" "$ARTIFACT_ROOT/status.json"; fi; else return 1; fi; }',
        'openclaw_e2e_print_log() { cat "$1"; }',
        'node() { case "$1" in --input-type=module|-p) command node "$@" ;; *) case "$2" in assert-restart-serving-turn) [ "$FAIL_AT" != serving ] ;; assert-exec-approvals|assert-config) : ;; assert-state) [ "$OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE" = post-inference ] && printf "survival\\n" >> "$EVENTS" ;; *) return 1 ;; esac ;; esac; }',
        "repair_update_restart_auth",
        'if [ "$RESIDENT" = 1 ]; then assert_survival; fi',
      ].join("\n"),
    ],
    {
      PATH: process.env.PATH,
      HOME: root,
      ARTIFACT_ROOT: root,
      EVENTS: events,
      FAIL_AT: failAt,
      RESIDENT: resident ? "1" : "0",
      RECOVERY_PLUGIN_MAINTENANCE_TIMEOUT_SECONDS: "2",
      [flag]: mode,
    },
  );
  return { ...observed, events: readFileSync(events, "utf8").trim().split("\n") };
}

function selectedMode(stdout: string) {
  const assignment = stdout.split("\n").find((line) => line.startsWith(flag + "="));
  return assignment?.slice(flag.length + 1) ?? "";
}

function expectMode(fixture: ReturnType<typeof target>, mode: string, env?: NodeJS.ProcessEnv) {
  const selected = fixture.select(env);
  expect(selected.status, selected.stderr).toBe(0);
  expect(selectedMode(selected.stdout)).toBe(mode);
  return mode;
}

describe.skipIf(process.platform === "win32")("frozen managed membership contract", () => {
  it("checks resident release identity through recovery and repeated survival", () => {
    const f = target(true);
    const run = runRecovery(f.root, "absent", "none", "", true);
    expect(run.status, run.stderr).toBe(0);
    expect(run.events.slice(-3)).toEqual(["assert-restart-serving-turn", "survival", "survival"]);
    expect(JSON.parse(readFileSync(join(f.root, "package.json"), "utf8"))).toEqual({
      version: "2100.0.0",
    });
  });

  it("waits for the resident recovery run's plugin maintenance before plugin checks", () => {
    const f = target(true);
    const late = runRecovery(f.root, "absent", "none", "", true, "late");
    expect(late.status, late.stderr).toBe(0);
    expect(late.events.slice(-4)).toEqual([
      "await-recovery-plugin-maintenance",
      "assert-restart-serving-turn",
      "survival",
      "survival",
    ]);
    const failed = runRecovery(f.root, "absent", "none", "", true, "failed");
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("whatsapp: registry unavailable");
    expect(failed.events).not.toContain("assert-restart-serving-turn");
    for (const plugins of ["absent", "wrong-run"] as const) {
      const unfinished = runRecovery(f.root, "absent", "none", "", true, plugins);
      expect(unfinished.status).not.toBe(0);
      expect(unfinished.stderr).toContain("did not finish for the recovery update");
      expect(unfinished.events).not.toContain("assert-restart-serving-turn");
    }
  });

  it("uses the committed pre-warning containment contract", () => {
    const f = target(false);
    // A dirty working file is not a capability of the frozen commit.
    writeFileSync(join(f.selected, terminalOwner), readFileSync(terminalOwner));
    const run = runRecovery(f.root, expectMode(f, "native"));
    expect(run.status, run.stderr).toBe(0);
    expect(run.events).toEqual([
      "stop-recovery-service",
      "prepare-restart-inference",
      "prepare-restart-plugin-selectors",
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

  it("requires both matching receipts for absent containment", () => {
    const f = target(true);
    const valid = runRecovery(f.root, expectMode(f, "absent"), "valid");
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

  it("rejects partial contracts and unqualified overrides", () => {
    const f = target(true, true);
    expect(f.select().status).not.toBe(0);
    const old = target(false);
    expectMode(old, "absent", {
      OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0",
      [flag]: "native",
    });
  });
});
