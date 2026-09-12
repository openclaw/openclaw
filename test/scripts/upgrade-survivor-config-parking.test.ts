import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PARKING_SCRIPT = "scripts/e2e/lib/upgrade-survivor/config-parking.mjs";
const RUNNER_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";
const RESTART_AUTH_SCRIPT = "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh";
const DOCKER_WRAPPER_SCRIPT = "scripts/e2e/upgrade-survivor-docker.sh";

describe("upgrade survivor config parking", () => {
  it("loads restart lifecycle helpers and mounts a supplied prepublish registry", () => {
    const runner = readFileSync(RUNNER_SCRIPT, "utf8");
    const wrapper = readFileSync(DOCKER_WRAPPER_SCRIPT, "utf8");
    expect(runner).toContain("source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh");
    expect(wrapper).toContain(
      "-e OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=/tmp/openclaw-prepublish-plugin-registry",
    );
    expect(wrapper).toContain(
      '-v "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:/tmp/openclaw-prepublish-plugin-registry:ro"',
    );
    expect(wrapper.match(/"\$\{PREPUBLISH_PLUGIN_REGISTRY_ARGS\[@\]\}"/gu)).toHaveLength(2);
  });

  it("propagates an early baseline gateway readiness failure", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-restart-readiness-"));
    try {
      const source = readFileSync(RUNNER_SCRIPT, "utf8");
      const start = source.lastIndexOf("\nstart_gateway() {");
      const end = source.indexOf("\nensure_gateway_started()", start);
      const gateway = join(root, "openclaw");
      writeFileSync(gateway, "#!/usr/bin/env bash\nsleep 30\n");
      chmodSync(gateway, 0o755);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -uo pipefail
openclaw_e2e_read_positive_int_env() { printf '90\\n'; }
openclaw_e2e_wait_gateway_ready() { return 1; }
openclaw_e2e_print_log() { :; }
${source.slice(start + 1, end)}
UPDATE_RESTART_MODE=manual
GATEWAY_LOG=${JSON.stringify(join(root, "gateway.log"))}
start_gateway
status=$?
[ -z "\${gateway_pid:-}" ] || kill "$gateway_pid" >/dev/null 2>&1 || true
exit "$status"`,
        ],
        { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } },
      );
      expect(result.status, result.stderr.toString()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates extended-stable by persisted channel without an explicit tag", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-update-channel-"));
    try {
      const source = readFileSync(RUNNER_SCRIPT, "utf8");
      const start = source.indexOf("\ncandidate_update_spec() {");
      const end = source.indexOf("\nassert_root_managed_vps_cli_usable()", start);
      const argsLog = join(root, "args.log");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
${source.slice(start + 1, end)}
openclaw_e2e_maybe_timeout() { shift; printf '%s\\n' "$*" >"$ARGS_LOG"; printf '{"status":"ok"}'; }
read_installed_version() { printf '2026.7.33\\n'; }
baseline_spec=openclaw@2026.6.35
CANDIDATE_KIND=npm
CANDIDATE_SPEC=openclaw@extended-stable
candidate_version=2026.7.33
UPDATE_RESTART_MODE=manual
ROOT_MANAGED_VPS=0
COMMAND_TIMEOUT=10s
UPDATE_JSON=${JSON.stringify(join(root, "update.json"))}
UPDATE_ERR=${JSON.stringify(join(root, "update.err"))}
ARTIFACT_ROOT=${JSON.stringify(root)}
OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL=extended-stable
update_candidate
! grep -q -- '--tag' "$ARGS_LOG"
grep -q -- 'OPENCLAW_UPDATE_PACKAGE_SPEC=openclaw' "$ARGS_LOG"
grep -q -- 'openclaw update --channel extended-stable --yes --json --no-restart' "$ARGS_LOG"
grep -q -- 'openclaw update --channel extended-stable --yes --json --no-restart' "$ARTIFACT_ROOT/update-command.args"
OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL=stable
update_candidate
grep -q -- 'openclaw update --tag openclaw@extended-stable --yes --json --no-restart' "$ARGS_LOG"`,
        ],
        {
          env: { ...process.env, ARGS_LOG: argsLog },
        },
      );
      expect(result.status, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops the service-owned replacement gateway before restoration", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-restart-stop-"));
    try {
      const systemctl = join(root, "systemctl");
      writeFileSync(
        systemctl,
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$SYSTEMCTL_LOG"
case "$*" in
  *stop*)
    pid="$(cat "$SYSTEMCTL_PID_FILE")"
    kill "$pid"
    rm -f "$SYSTEMCTL_PID_FILE" ;;
  *is-active*) exit 3 ;;
esac
`,
      );
      chmodSync(systemctl, 0o755);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
source ${JSON.stringify(RESTART_AUTH_SCRIPT)}
export SYSTEMCTL_LOG=${JSON.stringify(join(root, "systemctl.log"))}
export SYSTEMCTL_PID_FILE=${JSON.stringify(join(root, "systemctl.pid"))}
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG=${JSON.stringify(join(root, "gateway.log"))}
sleep 30 &
replacement_pid=$!
printf '%s\\n' "$replacement_pid" >"$SYSTEMCTL_PID_FILE"
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_e2e_probe_tcp() { return 1; }
openclaw_e2e_print_log() { :; }
stop_update_restart_probe_gateway 10s
[ ! -e "$SYSTEMCTL_PID_FILE" ]
grep -q -- '--user stop openclaw-gateway.service' "$SYSTEMCTL_LOG"
! kill -0 "$replacement_pid" >/dev/null 2>&1`,
        ],
        { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } },
      );
      expect(result.status, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parks a minimal auth-only gateway config and restores authored bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-config-parking-"));
    try {
      const configPath = join(root, "openclaw.json");
      const snapshotPath = join(root, "authored-config");
      const authored =
        '{\n  "plugins": { "entries": { "whatsapp": { "enabled": true } } },\n  "sentinel": true\n}\n';
      writeFileSync(configPath, authored);

      execFileSync(process.execPath, [
        PARKING_SCRIPT,
        "park-restart-probe",
        configPath,
        snapshotPath,
        "18789",
      ]);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        plugins: { enabled: false },
        gateway: {
          port: 18789,
          mode: "local",
          bind: "loopback",
          controlUi: { enabled: false },
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
          },
          reload: { mode: "off" },
        },
      });
      expect(readFileSync(snapshotPath, "utf8")).toBe(authored);

      execFileSync(process.execPath, [PARKING_SCRIPT, "restore", configPath, snapshotPath]);
      expect(readFileSync(configPath, "utf8")).toBe(authored);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
