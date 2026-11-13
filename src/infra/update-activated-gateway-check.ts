import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { readActiveGatewayLockIdentity } from "./gateway-lock.js";
import { tryListenOnPort } from "./ports-probe.js";
import { launchCanary, stopCanary } from "./update-candidate-canary-process.js";
import { UPDATE_CANARY_PROGRESS_ARGS } from "./update-candidate-canary-progress.js";
import {
  observeUpdateCandidateStartup,
  waitForUpdateCandidateReadiness,
} from "./update-candidate-canary-readiness.js";
import type { UpdateRunResult } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const STEP = "activated-gateway-startup";
const READINESS_BUDGET_MS = 120_000;

// The check boots the activated release on the operator's real state, so it
// must not reach external services: no channels, providers, cron or watchers.
const QUIET_STARTUP_ENV = {
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
  OPENCLAW_NO_AUTO_UPDATE: "1",
};

/**
 * Without a service restart nothing boots the activated release before the
 * operator next starts it. Boot it once on real state and fail the update when
 * it cannot become ready, so the existing post-activation rollback restores the
 * previous release. A Gateway that already owns the state keeps serving the old
 * code until its own restart; that case is reported, not checked.
 */
export async function checkActivatedGatewayStartup(params: {
  result: UpdateRunResult;
  env: NodeJS.ProcessEnv;
  /** Profiles without a configured local Gateway are not booted; the probe speaks plain HTTP only. */
  gateway?: { remote: boolean; tls: boolean };
  stateDir: string;
  nodeRunner?: string;
  assertCurrent: () => void;
}): Promise<UpdateRunResult> {
  const { result, env, stateDir } = params;
  const root = result.root;
  if (result.status !== "ok" || !root) {
    return result;
  }
  const started = Date.now();
  const finish = (step: Omit<UpdateStepResult, "name" | "command" | "cwd" | "durationMs">) => {
    const recorded: UpdateStepResult = {
      name: STEP,
      command: "gateway run",
      cwd: root,
      durationMs: Date.now() - started,
      ...step,
    };
    return recorded.exitCode === 0 || recorded.exitCode === null
      ? { ...result, steps: [...result.steps, recorded] }
      : {
          ...result,
          status: "error" as const,
          reason: "activated-gateway-startup-failed",
          steps: [...result.steps, recorded],
        };
  };
  const skipped = (message: string) =>
    finish({ exitCode: null, advisory: { kind: "recoverable-maintenance", message } });
  if (params.gateway?.remote) {
    return skipped(
      "This profile does not configure a local Gateway; the activated release was not started.",
    );
  }
  if (params.gateway?.tls) {
    // Accepted: the readiness probe is plain HTTP. TLS Gateways are verified on restart.
    return skipped("The Gateway serves TLS; startup is verified when it restarts.");
  }
  let entry: string | undefined;
  let port: number | void;
  try {
    const owner = await readActiveGatewayLockIdentity({ env });
    if (owner) {
      return skipped(
        `Gateway pid ${owner.pid} keeps serving the previous release until it restarts; the activated release was not started.`,
      );
    }
    entry = (await resolveGatewayInstallEntrypoint(root)) ?? undefined;
    port = entry ? await tryListenOnPort({ port: 0, host: "127.0.0.1" }) : undefined;
  } catch (error) {
    // Preparation failures still settle through post-activation rollback.
    return finish({ exitCode: 1, stderrTail: `Startup check could not start: ${String(error)}` });
  }
  if (!entry) {
    return finish({ exitCode: 1, stderrTail: "The update is missing its Gateway executable." });
  }
  if (!port) {
    return finish({ exitCode: 1, stderrTail: "No loopback port is available for startup." });
  }
  const childEnv = { ...env, ...QUIET_STARTUP_ENV };
  const log: string[] = [];
  const capture = (line: string) => {
    log.push(line);
    log.splice(0, Math.max(0, log.length - 40));
  };
  const startup = observeUpdateCandidateStartup({ env: childEnv, stateDir });
  const running = launchCanary({
    target: { kind: "cli", entryPath: entry },
    args: [
      "gateway",
      "run",
      ...UPDATE_CANARY_PROGRESS_ARGS,
      "--bind",
      "loopback",
      "--port",
      String(port),
    ],
    root,
    env: childEnv,
    nodeRunner: params.nodeRunner,
    stateDir,
    assertCurrent: params.assertCurrent,
    capture,
    onLine: startup.onLine,
  });
  const exited = new AbortController();
  running.child.once("exit", () => exited.abort()).once("error", () => exited.abort());
  let failure: unknown;
  try {
    const timedOut = await waitForUpdateCandidateReadiness({
      port,
      workDeadline: Date.now() + READINESS_BUDGET_MS,
      started,
      processExitSignal: exited.signal,
      assertCurrent: params.assertCurrent,
      hasExited: () => running.processExited() || running.hasExited(),
      getExitReason: running.stderrDiagnostic,
      startupProgress: startup.milestones,
      onWarning: capture,
      env: childEnv,
      stateDir,
      onEndpoint: () => {},
      capture,
    });
    if (timedOut) {
      return finish({ exitCode: 1, stderrTail: timedOut.message });
    }
    return finish({ exitCode: 0 });
  } catch (error) {
    failure = error;
    return finish({
      exitCode: running.child.exitCode || 1,
      stderrTail: [...log, String(error)].join("\n"),
    });
  } finally {
    await stopCanary({
      running,
      name: STEP,
      root,
      deadline: Date.now() + 10_000,
      recordStep: async () => {},
      primaryFailure: failure,
    });
  }
}
