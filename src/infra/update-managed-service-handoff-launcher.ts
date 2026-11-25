import fs from "node:fs/promises";
import path from "node:path";
import { escape as escapeGlob } from "minimatch";
import { serializeSystemdEnvironmentFile } from "../daemon/systemd-environment-files.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";

export const MANAGED_HANDOFF_BOOTSTRAP_SOURCE = String.raw`
const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
if (params.environmentPath) {
  try { fs.rmSync(params.environmentPath, { force: true }); }
  catch { appendLog("could not remove the private handoff environment file; terminal cleanup will retry"); }
}
// A transient service has its own systemd identity; it is not the Gateway being updated.
for (const key of ["INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM"]) delete process.env[key];
const requiresRequesterAcknowledgement = params.requester?.authorizationSource?.startsWith("profile:") === true;

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(params.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(params.logPath, "[" + new Date().toISOString() + "] " + line + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best effort only.
  }
}
`;

export function resolveSystemdHandoffLauncher(params: {
  serviceEnv: NodeJS.ProcessEnv;
  handoffId: string;
  triage: boolean;
  directory: string;
  environmentPath: string;
  executable: string;
  args: string[];
}) {
  const systemdRun = resolveExecutableFromPathEnv(
    "systemd-run",
    [params.serviceEnv.PATH ?? "", "/usr/bin", "/bin"].join(path.delimiter),
    params.serviceEnv,
  );
  if (!systemdRun) {
    throw new Error("systemd-run is required to launch a transient user unit");
  }
  const normalized = params.handoffId.trim().replace(/[^A-Za-z0-9_.:@-]+/gu, "-");
  const suffix = normalized.replace(/^-+|-+$/gu, "").slice(0, 80) || `${process.pid}-${Date.now()}`;
  const unit = `openclaw-${params.triage ? "triage" : "update"}-${suffix}.${params.triage ? "scope" : "service"}`;
  // Manager-owned services escape exec's subreaper as well as the Gateway cgroup.
  return {
    command: systemdRun,
    unit,
    args: [
      "--user",
      ...(params.triage
        ? ["--scope"]
        : [
            "--pipe",
            "--wait",
            "--service-type=exec",
            "--slice=app-openclaw-update.slice",
            "--property=KillMode=control-group",
            "--property=OOMPolicy=stop",
            `--property=EnvironmentFile=${escapeGlob(params.environmentPath)}`,
            `--working-directory=${params.directory}`,
          ]),
      "--collect",
      `--unit=${unit}`,
      ...(params.triage
        ? [`--property=PartOf=${resolveSystemdServiceName(params.serviceEnv)}.service`]
        : []),
      params.executable,
      ...params.args,
    ],
  };
}

/** Transfer exact prepared bytes without exposing values in the launcher argv. */
export async function writeSystemdHandoffEnvironment(
  environmentPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  await fs.writeFile(environmentPath, serializeSystemdEnvironmentFile(environment), {
    mode: 0o600,
    flag: "wx",
  });
}
