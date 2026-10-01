import { spawn } from "node:child_process";
import {
  InstalledAppLaunchRequestSchema,
  InstalledAppLaunchDispatchSchema,
  InstalledAppLaunchPermitSchema,
} from "../infra/installed-app-launch.js";
import { prepareLinuxInstalledApp } from "../infra/installed-apps-linux.js";
import { normalizeSystemRunApprovalPlan } from "../infra/system-run-approval-plan.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.node-host.js";
import type { NodeInvokeResponder } from "./client.js";
import type { runCommand } from "./invoke-run-command.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";
import type { SystemRunParams } from "./invoke-types.js";

/** Bind the existing node exec preparation to its own exact installed descriptor. */
export function prepareInstalledAppApproval(
  params: { installedApp?: unknown; command?: unknown },
  runtime: { installedAppsSharingEnabled?: boolean; installedAppsPlatform?: NodeJS.Platform },
) {
  if (params.installedApp === undefined) {
    return undefined;
  }
  const appRequest = InstalledAppLaunchRequestSchema.parse(params.installedApp);
  if (
    !runtime.installedAppsSharingEnabled ||
    (runtime.installedAppsPlatform ?? process.platform) !== "linux"
  ) {
    throw new Error("INSTALLED_APP_LAUNCH_DISABLED");
  }
  const app = prepareLinuxInstalledApp(appRequest.appId);
  if (
    !app ||
    app.app.appRevision !== appRequest.appRevision ||
    !Array.isArray(params.command) ||
    params.command.length !== 1 ||
    params.command[0] !== app.executable
  ) {
    throw new Error("INSTALLED_APP_CHANGED: refresh inventory before approval");
  }
  return appRequest;
}

/** Prepare only the installed native app identified by the node's own inventory. */
export function prepareInstalledAppLaunch(params: {
  paramsJSON?: string | null;
  sessionKey?: SystemRunParams["sessionKey"];
  sharingEnabled: boolean;
  platform: NodeJS.Platform;
  io?: OpenClawPluginNodeHostCommandIo;
}) {
  if (!params.sharingEnabled || params.platform !== "linux") {
    throw new Error("INSTALLED_APP_LAUNCH_DISABLED: enable Installed Apps on a Linux node");
  }
  const request = InstalledAppLaunchDispatchSchema.parse(JSON.parse(params.paramsJSON || "{}"));
  const prepared = prepareLinuxInstalledApp(request.appId);
  if (!prepared || prepared.app.appRevision !== request.appRevision) {
    throw new Error(
      "INSTALLED_APP_CHANGED: refresh device.apps and explicitly authorize the current app",
    );
  }
  const execution = request.execution;
  const plan = execution ? normalizeSystemRunApprovalPlan(execution.systemRunPlan) : null;
  if (
    execution &&
    (!plan ||
      plan.installedApp?.appId !== request.appId ||
      plan.installedApp?.appRevision !== request.appRevision)
  ) {
    throw new Error("INSTALLED_APP_CHANGED: approval plan does not bind this app revision");
  }
  const executionParams: SystemRunParams = execution
    ? { ...execution, systemRunPlan: plan }
    : { command: [prepared.executable], agentId: request.agentId, sessionKey: params.sessionKey };
  if (
    executionParams.agentId !== request.agentId ||
    executionParams.command.length !== 1 ||
    executionParams.command[0] !== prepared.executable
  ) {
    throw new Error("INSTALLED_APP_CHANGED: execution plan does not match the exact app");
  }
  let started:
    | { status: "process-started"; appId: string; appRevision: string; pid: number }
    | undefined;
  const run: typeof runCommand = async (argv, cwd, env, _timeout, signal, assertCurrent) => {
    signal?.throwIfAborted();
    const io = params.io;
    if (!io) {
      throw new Error("Installed-app launch requires invocation-owned authorization transport");
    }
    const readyAt = performance.now();
    const validForMs = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (value?: number, error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        io.signal.removeEventListener("abort", onAbort);
        if (value !== undefined) {
          resolve(value);
        } else {
          reject(
            error instanceof Error
              ? error
              : new Error("Installed-app authorization failed", { cause: error }),
          );
        }
      };
      const onAbort = () => finish(undefined, new Error("Installed-app invocation closed"));
      const timer = setTimeout(
        () => finish(undefined, new Error("Installed-app authorization timed out")),
        10_000,
      );
      io.signal.addEventListener("abort", onAbort, { once: true });
      io.onInput((raw) => {
        try {
          const permit = InstalledAppLaunchPermitSchema.parse(JSON.parse(raw));
          if (permit.type === "installed-app-launch.allow") {
            finish(permit.validForMs);
          } else {
            finish(undefined, new Error("Installed-app authorization is no longer current"));
          }
        } catch (error) {
          finish(undefined, error);
        }
      });
      if (io.signal.aborted) {
        onAbort();
        return;
      }
      void io
        .emitChunk(
          JSON.stringify({
            type: "installed-app-launch.ready",
            appId: request.appId,
            appRevision: request.appRevision,
          }),
        )
        .catch((error: unknown) => finish(undefined, error));
    });
    const current = prepareLinuxInstalledApp(request.appId);
    if (
      !current ||
      current.app.appRevision !== request.appRevision ||
      current.executable !== prepared.executable ||
      argv.length !== 1 ||
      argv[0] !== prepared.executable
    ) {
      throw new Error("INSTALLED_APP_CHANGED: launch descriptor changed before execution");
    }
    // The ordinary node exec owner supplied this guard after its own policy/approval work.
    // No asynchronous work may separate these checks from the actual spawn.
    assertCurrent?.();
    signal?.throwIfAborted();
    io.signal.throwIfAborted();
    if (performance.now() - readyAt >= validForMs) {
      throw new Error("Installed-app authorization expired before spawn");
    }
    const child = spawn(prepared.executable, [], {
      shell: false,
      detached: true,
      stdio: "ignore",
      cwd,
      env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        started = {
          status: "process-started",
          appId: request.appId,
          appRevision: request.appRevision,
          pid: child.pid!,
        };
        child.unref();
        resolve();
      });
    });
    return {
      success: true,
      exitCode: undefined,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: null,
      truncated: false,
    };
  };
  return {
    params: executionParams,
    invoke: async (
      options: Omit<Parameters<typeof handleSystemRunInvoke>[0], "sendInvokeResult"> & {
        sendInvokeResult: NodeInvokeResponder["send"];
      },
    ) => {
      try {
        await handleSystemRunInvoke({
          ...options,
          runCommand: run,
          sendNodeEvent: async () => {},
          sendExecFinishedEvent: async () => {},
          sendInvokeResult: async (result) => {
            await options.sendInvokeResult(
              started ? { ok: true, payload: { ...started, success: true } } : result,
            );
          },
        });
      } catch (error) {
        // Preserve app identity and OS errors instead of the unexpected-error fence.
        await options.sendInvokeResult({
          ok: false,
          error: {
            code: "INSTALLED_APP_LAUNCH_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
  };
}
