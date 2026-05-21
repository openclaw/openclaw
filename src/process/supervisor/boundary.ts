import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Supervisor survival boundary (gate G-D1).
 *
 * The in-memory process supervisor (`./supervisor.ts`) spawns workers as direct
 * children of the gateway. Direct children share the gateway's lifecycle domain
 * (POSIX process group, and under a managed install the gateway service cgroup),
 * so a gateway restart or `systemctl stop` tears the worker down with it.
 *
 * A `SupervisorBoundary` wraps a worker's argv so the worker runs in a lifecycle
 * domain that is independent of the gateway:
 *  - Linux: a transient `systemd-run --user --scope` unit. The scope is created
 *    under the user manager (`app.slice`), a sibling of the gateway service, so
 *    `systemctl --user stop <gateway>` kills only the gateway cgroup and the
 *    scope worker survives, finishes, and writes its terminal event.
 *  - Other / unavailable: the `inline` boundary, which spawns the worker
 *    directly with no survival guarantee (preserves legacy behavior).
 *
 * macOS has no survival boundary yet and resolves to `inline`. The obvious
 * `launchctl submit` analog of the systemd scope is unsafe here: it returns
 * immediately and hands the worker to launchd, so the supervisor loses the
 * child's lifetime, stdout/stderr, and terminal-event tracking. A correct macOS
 * boundary needs a bootstrapped launchd job (plist in `gui/<uid>`) with output
 * redirection and a real survival proof. See
 * `docs/superpowers/plans/2026-05-18-openclaw-multitasking-dgap1-supervisor-survival.md`.
 *
 * Because a survivable worker lives in a separate cgroup, a process-group or
 * process-tree kill cannot reach it. Explicit cancellation must instead stop the
 * unit (`stopCommand`).
 */

export type SupervisorBoundaryKind = "systemd-scope" | "inline";

export type SupervisorBoundaryPlanInput = {
  /** Fully resolved worker command + args to launch inside the boundary. */
  argv: string[];
  /** Stable run identifier; used to derive the transient unit name. */
  runId: string;
};

export type SupervisorStopCommand = {
  command: string;
  args: string[];
};

export type SupervisorLaunchPlan = {
  kind: SupervisorBoundaryKind;
  /** Command the supervisor child adapter actually spawns. */
  command: string;
  args: string[];
  /**
   * True when the launched worker runs in a lifecycle domain (cgroup scope)
   * independent of the supervisor, so it survives a supervisor (gateway) restart
   * or `systemctl stop`.
   */
  survivesSupervisorRestart: boolean;
  /** Transient unit identity, when the boundary creates one. */
  unitId?: string;
  /**
   * Best-effort command that stops the detached worker. A process-group/tree
   * kill cannot reach a worker in a separate cgroup, so explicit cancellation
   * must target the unit. `null` for the inline boundary.
   */
  stopCommand: SupervisorStopCommand | null;
};

export interface SupervisorBoundary {
  readonly kind: SupervisorBoundaryKind;
  plan(input: SupervisorBoundaryPlanInput): SupervisorLaunchPlan;
}

const SYSTEMD_UNIT_PREFIX = "openclaw-worker-";
const MAX_UNIT_FRAGMENT = 180;

function squashSeparators(value: string): string {
  return value.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * systemd unit names allow `[A-Za-z0-9:_.\-]`. Everything else becomes `-`.
 * Falls back to `anon` for an empty/garbage runId and caps the length so the
 * full `openclaw-worker-<fragment>.scope` stays well under systemd's limit.
 */
export function sanitizeSystemdUnitFragment(runId: string): string {
  const cleaned = squashSeparators(runId.replace(/[^A-Za-z0-9:_.-]/g, "-"));
  const fragment = cleaned.length > 0 ? cleaned : "anon";
  return fragment.slice(0, MAX_UNIT_FRAGMENT);
}

export function createSystemdScopeBoundary(): SupervisorBoundary {
  return {
    kind: "systemd-scope",
    plan: ({ argv, runId }) => {
      const unitId = `${SYSTEMD_UNIT_PREFIX}${sanitizeSystemdUnitFragment(runId)}.scope`;
      // `--quiet` keeps the worker's stdout/stderr clean (no "Running scope as
      // unit" banner). `--collect` garbage-collects the transient scope once the
      // worker exits. `--scope` runs the worker as a descendant but registers it
      // in a new cgroup under the user manager, separate from the gateway.
      const args = ["--user", "--scope", "--quiet", "--collect", `--unit=${unitId}`, "--", ...argv];
      return {
        kind: "systemd-scope",
        command: "systemd-run",
        args,
        survivesSupervisorRestart: true,
        unitId,
        stopCommand: { command: "systemctl", args: ["--user", "stop", unitId] },
      };
    },
  };
}

export function createInlineBoundary(): SupervisorBoundary {
  return {
    kind: "inline",
    plan: ({ argv }) => ({
      kind: "inline",
      command: argv[0] ?? "",
      args: argv.slice(1),
      survivesSupervisorRestart: false,
      stopCommand: null,
    }),
  };
}

function commandExistsOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (!pathValue) {
    return false;
  }
  const exts = platform === "win32" ? (env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE"]) : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return true;
        }
      } catch {
        // Unreadable PATH entry; keep scanning.
      }
    }
  }
  return false;
}

/**
 * `systemd-run --user --scope` needs both the binary and a reachable user
 * manager. We avoid spawning a probe here: the presence of the user bus socket
 * (`$XDG_RUNTIME_DIR/bus`) or `$DBUS_SESSION_BUS_ADDRESS` is a reliable, cheap
 * signal that a per-user systemd manager is available to register the scope.
 */
export function isSystemdUserScopeAvailable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "linux") {
    return false;
  }
  if (!commandExistsOnPath("systemd-run", env, platform)) {
    return false;
  }
  if (env.DBUS_SESSION_BUS_ADDRESS?.trim()) {
    return true;
  }
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir && existsSync(join(runtimeDir, "bus"))) {
    return true;
  }
  return false;
}

export type SupervisorBoundaryResolution = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Override the systemd availability probe (tests / explicit gating). */
  systemdAvailable?: boolean;
};

/**
 * Picks the survival boundary for the current platform, falling back to the
 * inline (no-survival) boundary when the platform integration is unavailable.
 * Only Linux has a survival boundary; macOS and other platforms resolve to
 * inline (see the file header for the macOS launchd gap).
 */
export function resolveSupervisorBoundary(
  opts: SupervisorBoundaryResolution = {},
): SupervisorBoundary {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === "linux") {
    const available = opts.systemdAvailable ?? isSystemdUserScopeAvailable(env, platform);
    return available ? createSystemdScopeBoundary() : createInlineBoundary();
  }
  return createInlineBoundary();
}

/**
 * Fire-and-forget unit stop for a detached, survivable worker. Cancellation of a
 * worker that lives in its own cgroup is advisory: the supervisor still kills
 * its local launcher process, but only the unit stop can reach the survivor.
 */
export function runBoundaryStopCommand(stop: SupervisorStopCommand | null | undefined): void {
  if (!stop) {
    return;
  }
  try {
    const child = spawn(stop.command, stop.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", () => {
      // Best-effort: the unit may already be gone.
    });
    child.unref();
  } catch {
    // Best-effort: cancellation of a detached worker is advisory.
  }
}
