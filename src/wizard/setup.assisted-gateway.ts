// Ensures agent-assisted setup has a reachable local Gateway before handoff.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveControlUiLinks, waitForGatewayReachable } from "../commands/onboard-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { probeGateway } from "../gateway/probe.js";
import { formatErrorMessage } from "../infra/errors.js";
import { findVerifiedGatewayListenerPidsOnPortSync } from "../infra/gateway-processes.js";
import { attachChildProcessBridge } from "../process/child-process-bridge.js";
import { killProcessTree } from "../process/kill-tree.js";
import { spawnWithFallback } from "../process/spawn-utils.js";
import { sleep } from "../utils.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type { GatewayWizardSettings } from "./setup.types.js";

type GatewayProbeAuth = {
  token?: string;
  password?: string;
};

export type AgentAssistedGatewayRuntime = {
  temporary: boolean;
  stop: () => Promise<void>;
};

async function probeExistingGateway(params: {
  url: string;
  auth: GatewayProbeAuth;
}): Promise<boolean> {
  // Do not let cached device credentials prove a listener that rejects the
  // active config's shared secret. The synthetic state path is never created.
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(os.tmpdir(), `openclaw-setup-gateway-probe-${randomUUID()}`),
  };
  const expected = await probeGateway({
    url: params.url,
    auth: params.auth,
    timeoutMs: 1500,
    detailLevel: "none",
    env,
  });
  return expected.ok;
}

function collectOutputTail(child: ChildProcess): () => string {
  let tail = "";
  const append = (chunk: Buffer | string) => {
    tail = `${tail}${String(chunk)}`.slice(-4000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => tail.trim();
}

async function stopTemporaryGateway(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  killProcessTree(pid, { detached: process.platform !== "win32", graceMs: 1500 });
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function resolveGatewayProbeAuth(params: {
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
}): Promise<GatewayProbeAuth> {
  if (params.settings.authMode === "token") {
    return { token: params.settings.gatewayToken };
  }
  if (params.settings.authMode !== "password" && params.settings.authMode !== "trusted-proxy") {
    return {};
  }
  const password = await resolveSetupSecretInputString({
    config: params.config,
    value: params.config.gateway?.auth?.password,
    path: "gateway.auth.password",
    env: process.env,
  });
  return password ? { password } : {};
}

async function waitForOwnedGatewayListener(params: {
  port: number;
  pid: number;
  deadlineMs: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.deadlineMs) {
    if (findVerifiedGatewayListenerPidsOnPortSync(params.port).includes(params.pid)) {
      return { ok: true };
    }
    await sleep(Math.max(0, Math.min(200, params.deadlineMs - (Date.now() - startedAt))));
  }
  return {
    ok: false,
    detail: `The temporary OpenClaw Gateway process is not listening on port ${params.port}.`,
  };
}

export async function ensureAgentAssistedGatewayRuntime(params: {
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
}): Promise<AgentAssistedGatewayRuntime> {
  const links = resolveControlUiLinks({
    bind: params.settings.bind,
    port: params.settings.port,
    customBindHost: params.settings.customBindHost,
    basePath: params.config.gateway?.controlUi?.basePath,
    tlsEnabled: params.config.gateway?.tls?.enabled === true,
  });
  const auth = await resolveGatewayProbeAuth(params);
  const probe = async (deadlineMs: number) => {
    return await waitForGatewayReachable({
      url: links.wsUrl,
      ...auth,
      deadlineMs,
    });
  };

  const existingReachable = await probeExistingGateway({
    url: links.wsUrl,
    auth,
  });
  if (
    existingReachable ||
    findVerifiedGatewayListenerPidsOnPortSync(params.settings.port).length > 0
  ) {
    throw new Error(
      `An existing Gateway is listening on port ${params.settings.port}, but setup cannot verify that it matches the active Gateway security settings. Stop the existing Gateway, then rerun onboarding.`,
    );
  }

  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port: params.settings.port,
    runtime: "node",
  });
  const [command, ...args] = programArguments;
  if (!command) {
    throw new Error("Unable to resolve the OpenClaw Gateway command.");
  }
  let child: ChildProcess;
  try {
    ({ child } = await spawnWithFallback({
      argv: [command, ...args],
      options: {
        cwd: workingDirectory,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          OPENCLAW_LOG_LEVEL: "silent",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    }));
  } catch (error) {
    throw new Error(`Unable to start Gateway for assisted setup: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
  const outputTail = collectOutputTail(child);
  const { detach } = attachChildProcessBridge(child);
  const temporaryRuntime: AgentAssistedGatewayRuntime = {
    temporary: true,
    stop: async () => {
      detach();
      await stopTemporaryGateway(child);
    },
  };

  try {
    const directReady = await probe(15_000);
    const childAlive = child.exitCode === null && child.signalCode === null;
    const ownedReady =
      !directReady.ok && params.settings.authMode === "trusted-proxy" && child.pid
        ? await waitForOwnedGatewayListener({
            port: params.settings.port,
            pid: child.pid,
            deadlineMs: 15_000,
          })
        : { ok: false, detail: "The temporary OpenClaw Gateway process has no PID." };
    // Trusted-proxy policy can reject direct local RPCs, so that mode falls back
    // to proving the listener belongs to the process started by this setup run.
    const ready = {
      ok: (directReady.ok && childAlive) || ownedReady.ok,
      detail: directReady.detail ?? ownedReady.detail,
    };
    if (!ready.ok) {
      const detail = outputTail() || ready.detail || "Gateway did not become reachable.";
      throw new Error(`Unable to start Gateway for assisted setup: ${formatErrorMessage(detail)}`);
    }

    await params.prompter.note(
      t("wizard.setup.agentAssistedGatewayReady"),
      t("wizard.setup.agentAssistedGatewayReadyTitle"),
    );
    return temporaryRuntime;
  } catch (error) {
    await temporaryRuntime.stop();
    throw error;
  }
}
