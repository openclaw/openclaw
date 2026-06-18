// Ensures agent-assisted setup has a reachable local Gateway before handoff.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveControlUiLinks } from "../commands/onboard-helpers.js";
import { DEFAULT_GATEWAY_PORT, resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { defaultGatewayBindMode, isLoopbackAddress } from "../gateway/net.js";
import { probeGateway, type GatewayProbeResult } from "../gateway/probe.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  readGatewayProcessArgsSync,
} from "../infra/gateway-processes.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
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

type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;

function resolveEffectiveGatewaySecurityPolicy(params: {
  gateway: GatewayConfig | undefined;
  authMode?: GatewayWizardSettings["authMode"];
  tailscaleMode: GatewayWizardSettings["tailscaleMode"];
}) {
  const authConfig = params.authMode
    ? { ...params.gateway?.auth, mode: params.authMode }
    : params.gateway?.auth;
  const auth = resolveGatewayAuth({
    authConfig,
    tailscaleMode: params.tailscaleMode,
  });
  const trustedProxy = auth.mode === "trusted-proxy" ? auth.trustedProxy : undefined;
  const rateLimit = authConfig?.rateLimit;
  return {
    auth: {
      mode: auth.mode,
      allowTailscale: auth.allowTailscale,
      rateLimit: {
        maxAttempts: rateLimit?.maxAttempts ?? 10,
        windowMs: rateLimit?.windowMs ?? 60_000,
        lockoutMs: rateLimit?.lockoutMs ?? 300_000,
        exemptLoopback: rateLimit?.exemptLoopback ?? true,
      },
      trustedProxy: trustedProxy
        ? {
            userHeader: trustedProxy.userHeader,
            requiredHeaders: [...(trustedProxy.requiredHeaders ?? [])].toSorted(),
            allowUsers: [...(trustedProxy.allowUsers ?? [])].toSorted(),
            allowLoopback: trustedProxy.allowLoopback === true,
          }
        : undefined,
    },
    trustedProxies: [...(params.gateway?.trustedProxies ?? [])].toSorted(),
    allowRealIpFallback: params.gateway?.allowRealIpFallback === true,
  };
}

function snapshotMatchesGatewaySettings(params: {
  configSnapshot: unknown;
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
}): boolean {
  const snapshot = asRecord(params.configSnapshot);
  const config = asRecord(snapshot?.config);
  const gateway = asRecord(config?.gateway);
  const tailscale = asRecord(gateway?.tailscale);
  const tailscaleMode =
    tailscale?.mode === undefined || tailscale.mode === "off"
      ? "off"
      : tailscale.mode === "serve" || tailscale.mode === "funnel"
        ? tailscale.mode
        : undefined;
  const bind = gateway?.bind ?? defaultGatewayBindMode(tailscaleMode);
  return (
    typeof snapshot?.path === "string" &&
    path.resolve(snapshot.path) === path.resolve(resolveConfigPath()) &&
    (gateway?.port ?? DEFAULT_GATEWAY_PORT) === params.settings.port &&
    bind === params.settings.bind &&
    gateway?.customBindHost === params.settings.customBindHost &&
    tailscaleMode === params.settings.tailscaleMode &&
    isDeepStrictEqual(
      resolveEffectiveGatewaySecurityPolicy({
        gateway: gateway as GatewayConfig | undefined,
        tailscaleMode,
      }),
      resolveEffectiveGatewaySecurityPolicy({
        gateway: params.config.gateway,
        authMode: params.settings.authMode,
        tailscaleMode: params.settings.tailscaleMode,
      }),
    ) &&
    (tailscale?.resetOnExit === true) === params.settings.tailscaleResetOnExit
  );
}

function resolveGatewayProcessOptionValue(args: string[], name: string): string | null | undefined {
  let value: string | null | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      value = next && !next.startsWith("-") ? next : null;
      index += 1;
      continue;
    }
    if (arg?.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1) || null;
    }
  }
  return value;
}

function hasGatewayProcessOption(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function runtimeExposureMatchesGatewaySettings(params: {
  listenerPids: number[];
  settings: GatewayWizardSettings;
}): boolean {
  return params.listenerPids.every((pid) => {
    const args = readGatewayProcessArgsSync(pid);
    if (!args) {
      return false;
    }
    const bind = resolveGatewayProcessOptionValue(args, "--bind");
    const tailscaleMode = resolveGatewayProcessOptionValue(args, "--tailscale");
    return (
      bind !== null &&
      tailscaleMode !== null &&
      (bind === undefined || bind === params.settings.bind) &&
      (tailscaleMode === undefined || tailscaleMode === params.settings.tailscaleMode) &&
      (!hasGatewayProcessOption(args, "--tailscale-reset-on-exit") ||
        params.settings.tailscaleResetOnExit)
    );
  });
}

function verifiedGatewayListenerStillOwnsPort(params: {
  port: number;
  listenerPids: number[];
}): boolean {
  return findVerifiedGatewayListenerPidsOnPortSync(params.port).some((pid) =>
    params.listenerPids.includes(pid),
  );
}

function buildInvalidProbeAuth(
  settings: GatewayWizardSettings,
  activeAuth: GatewayProbeAuth,
): GatewayProbeAuth | undefined {
  const invalidSecret = `openclaw-setup-invalid-${randomUUID()}`;
  if (settings.authMode === "token") {
    return { token: invalidSecret };
  }
  if (
    settings.authMode === "password" ||
    (settings.authMode === "trusted-proxy" && activeAuth.password)
  ) {
    return { password: invalidSecret };
  }
  return undefined;
}

function invalidAuthProbeProvesEnforcement(params: {
  settings: GatewayWizardSettings;
  probe: GatewayProbeResult;
}): boolean {
  const expectedCode =
    params.settings.authMode === "token"
      ? ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
      : params.settings.authMode === "password" || params.settings.authMode === "trusted-proxy"
        ? ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH
        : undefined;
  return (
    expectedCode !== undefined &&
    !params.probe.ok &&
    readConnectErrorDetailCode(params.probe.connectErrorDetails) === expectedCode
  );
}

function canSafelyProbeInvalidAuth(params: { url: string; config: OpenClawConfig }): boolean {
  if (params.config.gateway?.auth?.rateLimit?.exemptLoopback === false) {
    return false;
  }
  try {
    return isLoopbackAddress(new URL(params.url).hostname);
  } catch {
    return false;
  }
}

async function probeVerifiedExistingGateway(params: {
  url: string;
  auth: GatewayProbeAuth;
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
  listenerPids: number[];
}): Promise<boolean> {
  const invalidAuth =
    params.settings.authMode !== "none" && canSafelyProbeInvalidAuth(params)
      ? buildInvalidProbeAuth(params.settings, params.auth)
      : undefined;
  const listenerStillOwnsPort = () =>
    verifiedGatewayListenerStillOwnsPort({
      port: params.settings.port,
      listenerPids: params.listenerPids,
    });
  // Shared-secret Gateway reuse requires proving that invalid auth is rejected.
  // Fail closed when the rate-limit policy makes that probe unsafe.
  if (params.settings.authMode !== "none" && !invalidAuth) {
    return false;
  }
  if (!listenerStillOwnsPort()) {
    return false;
  }
  // Do not let cached device credentials prove a listener that rejects the
  // active config's shared secret.
  return await withTempWorkspace(
    { rootDir: os.tmpdir(), prefix: "openclaw-setup-gateway-probe-" },
    async (stateWorkspace) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateWorkspace.dir,
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
          config: params.config,
          settings: params.settings,
        })
      ) {
        return false;
      }
      if (!listenerStillOwnsPort()) {
        return false;
      }
      if (!invalidAuth) {
        return true;
      }
      if (!listenerStillOwnsPort()) {
        return false;
      }
      const invalid = await probeGateway({
        url: params.url,
        auth: invalidAuth,
        timeoutMs: 1500,
        detailLevel: "none",
        env,
      });
      return (
        listenerStillOwnsPort() &&
        invalidAuthProbeProvesEnforcement({ settings: params.settings, probe: invalid })
      );
    },
  );
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
  const configuredPassword = await resolveSetupSecretInputString({
    config: params.config,
    value: params.config.gateway?.auth?.password,
    path: "gateway.auth.password",
    env: process.env,
  });
  const password = resolveGatewayAuth({
    authConfig: { ...params.config.gateway?.auth, password: configuredPassword },
    tailscaleMode: params.settings.tailscaleMode,
    env: process.env,
  }).password;
  return password ? { password } : {};
}

async function waitForOwnedGatewayListener(params: {
  port: number;
  child: ChildProcess;
  deadlineMs: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const pid = params.child.pid;
  if (!pid) {
    return { ok: false, detail: "The temporary OpenClaw Gateway process has no PID." };
  }
  const resolveExitDetail = () => {
    return params.child.exitCode !== null || params.child.signalCode !== null
      ? `The temporary OpenClaw Gateway process exited before listening on port ${params.port}.`
      : undefined;
  };
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.deadlineMs) {
    const exitDetail = resolveExitDetail();
    if (exitDetail) {
      return { ok: false, detail: exitDetail };
    }
    if (findVerifiedGatewayListenerPidsOnPortSync(params.port).includes(pid)) {
      return { ok: true };
    }
    const postCheckExitDetail = resolveExitDetail();
    if (postCheckExitDetail) {
      return { ok: false, detail: postCheckExitDetail };
    }
    await sleep(Math.max(0, Math.min(200, params.deadlineMs - (Date.now() - startedAt))));
  }
  return {
    ok: false,
    detail: `The temporary OpenClaw Gateway process is not listening on port ${params.port}.`,
  };
}

function temporaryGatewayOwnsListener(params: { port: number; child: ChildProcess }): boolean {
  const pid = params.child.pid;
  return Boolean(
    pid &&
    params.child.exitCode === null &&
    params.child.signalCode === null &&
    findVerifiedGatewayListenerPidsOnPortSync(params.port).includes(pid),
  );
}

function temporaryGatewayOwnershipFailureDetail(params: {
  port: number;
  child: ChildProcess;
}): string {
  return params.child.exitCode !== null || params.child.signalCode !== null
    ? `The temporary OpenClaw Gateway process exited while probing port ${params.port}.`
    : `The temporary OpenClaw Gateway process no longer owns port ${params.port}.`;
}

async function waitForOwnedGatewayReachable(params: {
  url: string;
  auth: GatewayProbeAuth;
  port: number;
  child: ChildProcess;
  deadlineMs: number;
}): Promise<{ ok: boolean; detail?: string }> {
  if (!params.child.pid) {
    return { ok: false, detail: "The temporary OpenClaw Gateway process has no PID." };
  }
  const abortController = new AbortController();
  const abortProbe = () => abortController.abort();
  params.child.once("error", abortProbe);
  params.child.once("exit", abortProbe);
  const startedAt = Date.now();
  let lastDetail: string | undefined;
  try {
    while (Date.now() - startedAt < params.deadlineMs) {
      // Revalidate ownership immediately before every authenticated attempt.
      if (!temporaryGatewayOwnsListener(params)) {
        return { ok: false, detail: temporaryGatewayOwnershipFailureDetail(params) };
      }
      const remainingMs = params.deadlineMs - (Date.now() - startedAt);
      const probe = await probeGateway({
        url: params.url,
        auth: params.auth,
        timeoutMs: Math.min(1500, remainingMs),
        detailLevel: "none",
        signal: abortController.signal,
      });
      // Never accept a successful response after the owned listener has changed.
      if (!temporaryGatewayOwnsListener(params)) {
        return { ok: false, detail: temporaryGatewayOwnershipFailureDetail(params) };
      }
      if (probe.ok) {
        return { ok: true };
      }
      lastDetail = probe.error ?? undefined;
      const nextRemainingMs = params.deadlineMs - (Date.now() - startedAt);
      if (nextRemainingMs <= 0) {
        break;
      }
      await sleep(Math.min(400, nextRemainingMs));
    }
    return { ok: false, detail: lastDetail };
  } finally {
    params.child.removeListener("error", abortProbe);
    params.child.removeListener("exit", abortProbe);
  }
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
  // Assisted setup invokes the Gateway directly, so trusted-proxy mode needs
  // its documented local password fallback before the agent can use it.
  const hasDirectAuth = params.settings.authMode !== "trusted-proxy" || Boolean(auth.password);

  // Never send active Gateway credentials until the listener owner is verified.
  const existingListenerPids = findVerifiedGatewayListenerPidsOnPortSync(params.settings.port);
  if (existingListenerPids.length > 0) {
    const canVerifyExisting =
      runtimeExposureMatchesGatewaySettings({
        listenerPids: existingListenerPids,
        settings: params.settings,
      }) && hasDirectAuth;
    const existingMatches =
      canVerifyExisting &&
      (await probeVerifiedExistingGateway({
        url: links.wsUrl,
        auth,
        config: params.config,
        settings: params.settings,
        listenerPids: existingListenerPids,
      }));
    if (
      existingMatches &&
      verifiedGatewayListenerStillOwnsPort({
        port: params.settings.port,
        listenerPids: existingListenerPids,
      })
    ) {
      return NOOP_GATEWAY_RUNTIME;
    }
    throw new Error(
      `An existing Gateway is listening on port ${params.settings.port}, but setup cannot verify that it matches the active Gateway security settings. Stop the existing Gateway, then rerun onboarding.`,
    );
  }
  if (!hasDirectAuth) {
    throw new Error(
      "Agent-assisted setup requires gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD when using trusted-proxy Gateway auth so local setup tasks can authenticate. Configure a password fallback, then rerun onboarding.",
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
    // A competing process can win the port bind after the initial listener check.
    const ownedReady = await waitForOwnedGatewayListener({
      port: params.settings.port,
      child,
      deadlineMs: 15_000,
    });
    const directReady = ownedReady.ok
      ? await waitForOwnedGatewayReachable({
          url: links.wsUrl,
          auth,
          port: params.settings.port,
          child,
          deadlineMs: 15_000,
        })
      : { ok: false, detail: ownedReady.detail };
    const ready = {
      ok: ownedReady.ok && directReady.ok,
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
