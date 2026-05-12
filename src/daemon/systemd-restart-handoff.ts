import { spawn } from "node:child_process";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { renderPosixRestartLogSetup } from "./restart-logs.js";
import type { GatewayServiceEnv } from "./service-types.js";

type SystemdRestartHandoffResult = {
  ok: boolean;
  pid?: number;
  detail?: string;
};

const SYSTEMD_UNIT_NAME_RE = /^[A-Za-z0-9:_.@\\-]+\.service$/;

function normalizeSystemdUnitName(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith(".service") ? trimmed : `${trimmed}.service`;
}

function assertValidSystemdUnitName(unitName: string): string {
  if (!SYSTEMD_UNIT_NAME_RE.test(unitName)) {
    throw new Error(`Invalid systemd unit name: ${unitName}`);
  }
  return unitName;
}

function readCurrentSystemdUnitName(env: GatewayServiceEnv): string | null {
  const raw = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  return raw ? normalizeSystemdUnitName(raw) : null;
}

export function isCurrentProcessSystemdGatewayService(
  unitName: string,
  env: GatewayServiceEnv,
): boolean {
  const marker = env.OPENCLAW_SERVICE_MARKER?.trim();
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  const currentUnit = readCurrentSystemdUnitName(env);
  return marker === "openclaw" && serviceKind === "gateway" && currentUnit === unitName;
}

function buildSystemdRestartHandoffScript(restartLogEnv: GatewayServiceEnv): string {
  return `unit_name="$1"
wait_pid="$2"
${renderPosixRestartLogSetup(restartLogEnv)}
printf '[%s] openclaw restart attempt source=systemd-handoff target=%s waitPid=%s\\n' "$(date -u +%FT%TZ)" "$unit_name" "$wait_pid" >&2
if [ -n "$wait_pid" ] && [ "$wait_pid" -gt 1 ] 2>/dev/null; then
  while kill -0 "$wait_pid" >/dev/null 2>&1; do
    sleep 0.1
  done
fi
if systemctl --user restart "$unit_name"; then
  printf '[%s] openclaw restart done source=systemd-handoff\\n' "$(date -u +%FT%TZ)" >&2
  exit 0
fi
status=$?
printf '[%s] openclaw restart failed source=systemd-handoff status=%s\\n' "$(date -u +%FT%TZ)" "$status" >&2
exit "$status"
`;
}

export function scheduleDetachedSystemdRestartHandoff(params: {
  env: GatewayServiceEnv;
  unitName: string;
  waitForPid?: number;
}): SystemdRestartHandoffResult {
  try {
    const unitName = assertValidSystemdUnitName(params.unitName);
    const handoffUnit = assertValidSystemdUnitName(
      `openclaw-gateway-restart-handoff-${process.pid}.service`,
    );
    const waitForPid = String(params.waitForPid ?? process.pid);
    const child = spawn(
      "systemd-run",
      [
        "--user",
        "--collect",
        `--unit=${handoffUnit}`,
        "--description=OpenClaw gateway restart handoff",
        "/bin/sh",
        "-c",
        buildSystemdRestartHandoffScript(params.env),
        "openclaw-systemd-restart-handoff",
        unitName,
        waitForPid,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: sanitizeHostExecEnv({ baseEnv: { ...process.env, ...params.env } }),
      },
    );
    child.unref();
    return { ok: true, pid: child.pid ?? undefined };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
