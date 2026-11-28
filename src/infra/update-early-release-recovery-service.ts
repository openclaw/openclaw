import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../daemon/launchd-plist.js";
import { escapeXml } from "../shared/xml.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "./gateway-shutdown-budget.js";
import type { RecoveryPlan } from "./update-early-release-recovery-record.js";

/**
 * The early release recovery's view of the two user service managers it runs under (see
 * `update-early-release-recovery.ts`): the Gateway service it moves, and its own job, which
 * outlives the updater and the Gateway restarts. systemd gets a transient user service;
 * launchd gets a separate job in the GUI domain, which a Gateway bootout does not reach.
 * Remove with the recovery.
 */

export type CommandResult = { code: number | null; output: string };
export type RunCommand = (
  argv: string[],
  options?: { cwd?: string; stream?: boolean; timeoutMs?: number },
) => Promise<CommandResult>;

const ok = (result: CommandResult) => result.code === 0;

/** The Gateway service, as the runner drives it. */
export type GatewayServiceControl = {
  /** "active" while it runs; otherwise "failed" (systemd gave up) or "inactive". */
  state(): Promise<string>;
  /** Why systemd gave up on it, when it did. */
  failure(): Promise<string>;
  /** Times the manager restarted it after it exited. */
  restarts(): Promise<number>;
  /** Restarts the manager allows before it gives up; launchd never does, so its default. */
  startLimit(): Promise<number>;
  /** Stops it, waiting as long as the manager lets it stop; true once it is confirmed down. */
  stop(): Promise<boolean>;
  /** Starts it from its definition on disk, after a put-back or a failure. */
  start(wait: boolean): Promise<void>;
  /** The command line the manager loaded for it and the process it runs now ("" when none). */
  loaded(): Promise<{ command: string; pid: string }>;
  /** Commands that show why it does not run. */
  describe: string;
};

/** The service manager's own label for an exit, read by the readiness wait. */
async function systemctlShow(run: RunCommand, unit: string, key: string): Promise<string> {
  return (
    await run(["systemctl", "--user", "show", `--property=${key}`, "--value", unit])
  ).output.trim();
}

/** A time span as `systemctl show` prints it ("5min 30s"); null for "infinity" or anything else. */
function parseSystemdSpanMs(text: string): number | null {
  const units: Record<string, number> = { us: 1e-3, ms: 1, s: 1e3, min: 6e4, h: 36e5, d: 864e5 };
  let total = 0;
  const rest = text
    .trim()
    .replace(/(\d+(?:\.\d+)?)(min|ms|us|h|d|s)\b\s*/gu, (_, n: string, unit: string) => {
      total += Number(n) * (units[unit] ?? Number.NaN);
      return "";
    });
  return text.trim() && !rest ? total : null;
}

function systemdControl(plan: RecoveryPlan, run: RunCommand): GatewayServiceControl {
  const gateway = path.basename(plan.serviceFile);
  const systemctl = (...args: string[]) => run(["systemctl", "--user", ...args]);
  return {
    state: () => systemctlShow(run, gateway, "ActiveState"),
    failure: () => systemctlShow(run, gateway, "Result"),
    restarts: async () => Number(await systemctlShow(run, gateway, "NRestarts")) || 0,
    // The installed Gateway unit's burst, when systemd does not report one.
    startLimit: async () => Number(await systemctlShow(run, gateway, "StartLimitBurst")) || 10,
    stop: async () => {
      // A release inside a migration commits it before it exits, so this waits as long as
      // systemd lets the unit stop, plus a minute for its final kill.
      const limit = await systemctlShow(run, gateway, "TimeoutStopUSec");
      const stopMs = parseSystemdSpanMs(limit) ?? GATEWAY_SERVICE_STOP_TIMEOUT_MS;
      const stopped = await run(["systemctl", "--user", "stop", gateway], {
        timeoutMs: stopMs + 6e4,
      });
      return (
        ok(stopped) &&
        ["inactive", "failed"].includes(await systemctlShow(run, gateway, "ActiveState"))
      );
    },
    start: async (wait) => {
      await systemctl("daemon-reload");
      // A unit that hit its start limit starts again only after this.
      await systemctl("reset-failed", gateway);
      await systemctl("start", ...(wait ? [] : ["--no-block"]), gateway);
    },
    loaded: async () => {
      const pid = await systemctlShow(run, gateway, "MainPID");
      return {
        command: await systemctlShow(run, gateway, "ExecStart"),
        pid: pid === "0" ? "" : pid,
      };
    },
    describe: `\`systemctl --user status ${gateway}\` and \`journalctl --user -u ${gateway}\``,
  };
}

/** `launchctl print` of a loaded job; null when it is not loaded. */
async function launchctlPrint(run: RunCommand, target: string): Promise<string | null> {
  const printed = await run(["launchctl", "print", target]);
  return ok(printed) ? printed.output : null;
}

/** A top-level `key = value` line of `launchctl print`. */
function printedValue(printed: string | null, key: string): string {
  return new RegExp(`^\\t${key} = (.+)$`, "mu").exec(printed ?? "")?.[1]?.trim() ?? "";
}

function launchdControl(plan: RecoveryPlan, run: RunCommand): GatewayServiceControl {
  const domain = plan.domain ?? "";
  const target = `${domain}/${path.basename(plan.serviceFile, ".plist")}`;
  return {
    state: async () => {
      const printed = await launchctlPrint(run, target);
      return printedValue(printed, "state") === "running" ? "active" : "inactive";
    },
    failure: async () => "",
    // launchd counts every start; the first is not a restart.
    restarts: async () =>
      Math.max(0, (Number(printedValue(await launchctlPrint(run, target), "runs")) || 1) - 1),
    // KeepAlive restarts it after every exit and never gives up; stop after as many restarts as
    // systemd's default burst allows.
    startLimit: async () => 10,
    stop: async () => {
      // launchd stops the job within its ExitTimeOut, then kills it.
      await run(["launchctl", "bootout", target], {
        timeoutMs: (LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 60) * 1000,
      });
      // The label stays registered until the stop finished.
      for (let attempt = 0; attempt < LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 15; attempt++) {
        if ((await launchctlPrint(run, target)) === null) {
          return true;
        }
        await delay(1000);
      }
      return false;
    },
    start: async () => {
      await run(["launchctl", "enable", target]);
      if ((await launchctlPrint(run, target)) === null) {
        await run(["launchctl", "bootstrap", domain, plan.serviceFile]);
      } else {
        await run(["launchctl", "kickstart", target]);
      }
    },
    loaded: async () => {
      const printed = await launchctlPrint(run, target);
      return {
        command: /^\targuments = \{\n([\s\S]*?)^\t\}/mu.exec(printed ?? "")?.[1] ?? "",
        pid: printedValue(printed, "pid"),
      };
    },
    describe: `\`launchctl print ${target}\` and the Gateway log in the state directory's \`logs\``,
  };
}

export function gatewayServiceControl(plan: RecoveryPlan, run: RunCommand): GatewayServiceControl {
  return plan.supervisor === "launchd" ? launchdControl(plan, run) : systemdControl(plan, run);
}

/** Restarts the manager made of the recovery's own job after an abnormal exit. */
export async function recoveryJobRestarts(plan: RecoveryPlan, run: RunCommand): Promise<number> {
  if (plan.supervisor === "launchd") {
    const printed = await launchctlPrint(run, `${plan.domain}/${plan.unit}`);
    return Math.max(0, (Number(printedValue(printed, "runs")) || 1) - 1);
  }
  return Number(await systemctlShow(run, plan.unit, "NRestarts")) || 0;
}

/** Whether the recovery job is running (a concurrent check reports it instead of starting). */
export async function isRecoveryJobRunning(
  supervisor: RecoveryPlan["supervisor"],
  unit: string,
  domain: string | undefined,
  run: RunCommand,
): Promise<boolean> {
  if (supervisor === "launchd") {
    return printedValue(await launchctlPrint(run, `${domain}/${unit}`), "state") === "running";
  }
  const state = (await run(["systemctl", "--user", "is-active", unit])).output.trim();
  return ["active", "activating", "deactivating", "reloading"].includes(state);
}

/** How the user follows the recovery job. */
export function describeRecoveryJob(
  supervisor: RecoveryPlan["supervisor"],
  unit: string,
  domain: string | undefined,
  log: string,
): { status: string; log: string } {
  return supervisor === "launchd"
    ? { status: `launchctl print ${domain}/${unit}`, log }
    : { status: `systemctl --user status ${unit}`, log: `journalctl --user -u ${unit}` };
}

/**
 * The launchd job: no KeepAlive except after a crash (systemd's Restart=on-abnormal), its
 * output appended to `log`.
 */
function buildRecoveryJobPlist(params: {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  log: string;
}): string {
  const strings = (values: string[]) =>
    values.map((value) => `<string>${escapeXml(value)}</string>`).join("");
  const environment = Object.entries(params.environment)
    .map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(params.label)}</string>
<key>ProgramArguments</key><array>${strings(params.programArguments)}</array>
<key>WorkingDirectory</key><string>${escapeXml(params.workingDirectory)}</string>
<key>EnvironmentVariables</key><dict>${environment}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
<key>ThrottleInterval</key><integer>15</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardInPath</key><string>/dev/null</string>
<key>StandardOutPath</key><string>${escapeXml(params.log)}</string>
<key>StandardErrorPath</key><string>${escapeXml(params.log)}</string>
</dict></plist>
`;
}

/** Starts the recovery job; null on success, else why not. */
export async function startRecoveryJob(params: {
  plan: RecoveryPlan;
  run: RunCommand;
  programArguments: string[];
  environment: Record<string, string>;
}): Promise<string | null> {
  const { plan, run, programArguments, environment } = params;
  if (plan.supervisor === "launchd") {
    const { domain = "", log = "" } = plan;
    const target = `${domain}/${plan.unit}`;
    // A finished earlier recovery stays loaded until logout; this one replaces it.
    if ((await launchctlPrint(run, target)) !== null) {
      await run(["launchctl", "bootout", target]);
    }
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const plistPath = path.join(path.dirname(plan.release), `${plan.unit}.plist`);
    fs.writeFileSync(
      plistPath,
      buildRecoveryJobPlist({
        label: plan.unit,
        programArguments,
        workingDirectory: plan.checkout,
        environment,
        log,
      }),
      // launchd refuses a user LaunchAgent plist that group and others cannot read.
      { mode: 0o644 },
    );
    const started = await run(["launchctl", "bootstrap", domain, plistPath]);
    return ok(started) ? null : `launchctl bootstrap failed (${tail(started)})`;
  }
  const started = await run([
    "systemd-run",
    "--user",
    `--unit=${plan.unit}`,
    "--collect",
    "--quiet",
    "--description=OpenClaw update recovery",
    "--property=Restart=on-abnormal",
    "--property=RestartSec=15s",
    `--working-directory=${plan.checkout}`,
    ...Object.entries(environment).map(([key, value]) => `--setenv=${key}=${value}`),
    // systemd expands `$NAME` in a service's command line; `$$` passes a literal `$`.
    ...programArguments.map((arg) => arg.replaceAll("$", () => "$$")),
  ]);
  return ok(started) ? null : `systemd-run failed (${tail(started)})`;
}

/** Retires a launchd recovery job once it is done; systemd collects its own (`--collect`). */
export async function retireRecoveryJob(plan: RecoveryPlan, run: RunCommand): Promise<void> {
  if (plan.supervisor === "launchd") {
    // Last: a job that boots itself out is stopped by it.
    await run(["launchctl", "bootout", `${plan.domain}/${plan.unit}`]);
  }
}

const tail = (result: CommandResult) =>
  result.output.trim().split("\n").slice(-6).join(" ").slice(-600);
