// Ensures agent-assisted setup has a reachable local Gateway before handoff.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveControlUiLinks, waitForGatewayReachable } from "../commands/onboard-helpers.js";
import { resolveConfigPath } from "../config/paths.js";
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

const NOOP_GATEWAY_RUNTIME: AgentAssistedGatewayRuntime = {
  temporary: false,
  stop: async () => {},
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function snapshotMatchesGatewaySettings(params: {
  configSnapshot: unknown;
  settings: GatewayWizardSettings;
}): boolean {
  const snapshot = asRecord(params.configSnapshot);
  const config = asRecord(snapshot?.config);
  const gateway = asRecord(config?.gateway);
  const auth = asRecord(gateway?.auth);
  const tailscale = asRecord(gateway?.tailscale);
  return (
    typeof snapshot?.path === "string" &&
    path.resolve(snapshot.path) === path.resolve(resolveConfigPath()) &&
    gateway?.port === params.settings.port &&
    gateway.bind === params.settings.bind &&
    gateway.customBindHost === params.settings.customBindHost &&
    auth?.mode === params.settings.authMode &&
    (tailscale?.mode ?? "off") === params.settings.tailscaleMode &&
    (tailscale?.resetOnExit === true) === params.settings.tailscaleResetOnExit
  );
}

function buildInvalidProbeAuth(settings: GatewayWizardSettings): GatewayProbeAuth | undefined {
  const invalidSecret = `openclaw-setup-invalid-${randomUUID()}`;
  if (settings.authMode === "token") {
    return { token: invalidSecret };
  }
  if (settings.authMode === "password") {
    return { password: invalidSecret };
  }
  return undefined;
}

async function probeVerifiedExistingGateway(params: {
  url: string;
  auth: GatewayProbeAuth;
  settings: GatewayWizardSettings;
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
    detailLevel: "full",
    env,
  });
  if (
    !expected.ok ||
    !snapshotMatchesGatewaySettings({
      configSnapshot: expected.configSnapshot,
      settings: params.settings,
    })
  ) {
    return false;
  }
  const invalidAuth = buildInvalidProbeAuth(params.settings);
  if (!invalidAuth) {
    return true;
  }
  const invalid = await probeGateway({
    url: params.url,
    auth: invalidAuth,
    timeoutMs: 1500,
    detailLevel: "none",
    env,
  });
  return !invalid.ok;
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

  // Never send active Gateway credentials until the listener owner is verified.
  const existingListenerPids = findVerifiedGatewayListenerPidsOnPortSync(params.settings.port);
  if (existingListenerPids.length > 0) {
    const existingMatches =
      params.settings.authMode !== "trusted-proxy" &&
      (await probeVerifiedExistingGateway({
        url: links.wsUrl,
        auth,
        settings: params.settings,
      }));
    if (
      existingMatches &&
      findVerifiedGatewayListenerPidsOnPortSync(params.settings.port).some((pid) =>
        existingListenerPids.includes(pid),
      )
    ) {
      return NOOP_GATEWAY_RUNTIME;
    }
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
    const childAlive = child.exitCode === null && child.signalCode === null;
    // A competing process can win the port bind after the initial listener check.
    const ownedReady = child.pid
      ? await waitForOwnedGatewayListener({
          port: params.settings.port,
          pid: child.pid,
          deadlineMs: 15_000,
        })
      : { ok: false, detail: "The temporary OpenClaw Gateway process has no PID." };
    const directReady =
      ownedReady.ok && params.settings.authMode !== "trusted-proxy"
        ? await probe(15_000)
        : { ok: false, detail: ownedReady.detail };
    // Trusted-proxy policy can reject direct local RPCs, so that mode relies on
    // proving the listener belongs to the process started by this setup run.
    const ready = {
      ok:
        childAlive &&
        ownedReady.ok &&
        (params.settings.authMode === "trusted-proxy" || directReady.ok),
      detail: ownedReady.detail ?? directReady.detail,
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
