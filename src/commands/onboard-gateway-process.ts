import { CLI_RESPAWN_PARENT_ENV } from "../../cli-parent-lifetime.mjs";
import { isGatewayProtocolResponseError } from "../../packages/gateway-client/src/protocol-request.js";
import { registerSignalExitGate } from "../cli/signal-exit-barrier.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { resolveCurrentOpenClawCliInvocation } from "../infra/openclaw-cli-invocation.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { signalChildProcessTree } from "../process/child-process-tree.js";
import { spawnAndWait } from "../process/spawn-utils.js";
import { settlesWithin } from "../shared/settle-within.js";

async function requestOwnedGatewayStop(pid: number | undefined): Promise<boolean> {
  try {
    const { readActiveGatewayLockIdentity } = await import("../infra/gateway-lock.js");
    const owner = await readActiveGatewayLockIdentity();
    if (!owner || owner.pid !== pid || !owner.ownerId) {
      return false;
    }
    const { callGatewayCli } = await import("../gateway/call.js");
    let dispatched = false;
    try {
      await callGatewayCli({
        method: "gateway.stop.request",
        params: { target: { pid: owner.pid, ownerId: owner.ownerId, port: owner.port } },
        localPortOverride: owner.port,
        sharedStateMode: "read-only",
        allowLocalBackendAuthNone: true,
        requiredMethods: ["gateway.stop.request"],
        timeoutMs: 10_000,
        assertDispatchCurrent: () => {
          dispatched = true;
        },
      });
    } catch (error) {
      // A lost reply may follow acceptance; the targeted request is revalidated by the Gateway.
      if (isGatewayProtocolResponseError(error)) {
        dispatched = false;
      }
    }
    return dispatched;
  } catch {
    return false;
  }
}

export type OnboardingGatewayProcess = {
  wait: Promise<void>;
  close: () => Promise<void>;
};

/** Setup keeps its one-shot database role; the child owns Gateway admission and shutdown. */
export async function startOnboardingGatewayProcess(
  options: { port?: number } = {},
): Promise<OnboardingGatewayProcess> {
  const invocation = resolveCurrentOpenClawCliInvocation([
    "gateway",
    "run",
    ...(options.port === undefined ? [] : ["--port", String(options.port)]),
  ]);
  const detached = process.platform !== "win32";
  const child = await spawnAndWait({
    argv: [invocation.command, ...invocation.args],
    options: {
      cwd: tryProcessCwd() ?? invocation.cwd,
      env: { ...process.env, ...invocation.env, [CLI_RESPAWN_PARENT_ENV]: String(process.pid) },
      // Terminal Ctrl+C belongs to this parent. IPC retains the CLI's existing parent-loss contract.
      detached,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    },
  });
  let exited = false;
  let processError: Error | undefined;
  child.on("error", (error) => {
    processError = error;
  });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
    },
  );
  const wait = completion.then(({ code, signal }) => {
    if (processError) {
      throw processError;
    }
    if (code !== 0 || signal) {
      throw new Error(
        `Gateway process exited ${signal ? `with signal ${signal}` : `with code ${code ?? "unknown"}`}`,
      );
    }
  });
  // The foreground handoff awaits this result; classic setup observes readiness separately.
  void wait.catch(() => {});
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      const requestedStop = !exited && (await requestOwnedGatewayStop(child.pid));
      if (!exited && !requestedStop) {
        child.kill("SIGTERM");
      }
      if (!exited && !(await settlesWithin(completion, GATEWAY_SERVICE_STOP_TIMEOUT_MS))) {
        await new Promise<void>((resolve) => {
          signalChildProcessTree(child, "SIGKILL", resolve);
        });
      }
      await wait;
    })().finally(() => unregisterGate());
    return closePromise;
  };
  // Interrupt before the outer CLI gate waits for this foreground command to finish.
  const unregisterGate = registerSignalExitGate(
    completion.then(() => {}),
    () => {
      void close().catch((error: unknown) => process.stderr.write(`${String(error)}\n`));
    },
  );
  return { wait, close };
}
