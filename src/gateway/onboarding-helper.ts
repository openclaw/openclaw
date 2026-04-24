import {
  encodePairingSetupCode,
  resolvePairingSetupFromConfig,
  type PairingSetupResolution,
} from "../pairing/setup-code.js";
import { callGatewayScoped } from "./call.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./method-scopes.js";
import {
  PROTOCOL_VERSION,
  type WizardNextResult,
  type WizardStatusResult,
  type WizardStartResult,
} from "./protocol/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isLocalGatewayUrl } from "./net.js";

export type OnboardingHelperOptions = {
  url?: string;
  timeoutMs?: number;
  token?: string;
  password?: string;
  configPath?: string;
};

export type OnboardingWizardFlow = "quickstart" | "advanced";

export type OnboardingWizardAnswer = {
  stepId: string;
  value?: unknown;
};

export type OnboardingPairingPayload = {
  url: string | null;
  token: string | null;
  password: string | null;
  authLabel: "token" | "password" | null;
  urlSource: string | null;
  setupCode: string | null;
  error: string | null;
};

export type OnboardingProbeSnapshot = {
  action: "probe-onboarding";
  checkedAt: string;
  gatewayUrl: string | null;
  gatewayReachable: boolean;
  pairing: OnboardingPairingPayload;
};

export type OnboardingPairingSnapshot = {
  action: "get-pairing-setup" | "complete-pairing";
  checkedAt: string;
  gatewayUrl: string | null;
  gatewayReachable: boolean;
  pairing: OnboardingPairingPayload;
  verified: boolean;
};

type OnboardingHelperDeps = {
  callGatewayScoped: typeof callGatewayScoped;
  loadConfig: typeof loadConfig;
  resolvePairingSetupFromConfig: typeof resolvePairingSetupFromConfig;
  encodePairingSetupCode: typeof encodePairingSetupCode;
  runCommandWithTimeout: typeof runCommandWithTimeout;
};

const defaultDeps: OnboardingHelperDeps = {
  callGatewayScoped,
  loadConfig,
  resolvePairingSetupFromConfig,
  encodePairingSetupCode,
  runCommandWithTimeout,
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function trimToNull(value: unknown): string | null {
  return trimToUndefined(value) ?? null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function isUnsafeRemotePairingUrl(rawUrl: string | null): boolean {
  if (!rawUrl) {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "ws:" && !isLocalGatewayUrl(rawUrl);
  } catch {
    return false;
  }
}

function getUnsafeRemotePairingMessage(rawUrl: string): string {
  return [
    `Current pairing target resolves to insecure remote ws:// (${rawUrl}).`,
    "OpenClaw blocks plaintext remote pairing because credentials and chat data would be exposed.",
    "Use Tailscale Serve/Funnel, a wss:// publicUrl, or an SSH tunnel.",
  ].join(" ");
}

function resolveGatewayTarget(url: string | undefined, deps: OnboardingHelperDeps) {
  const config = deps.loadConfig();
  const normalizedUrl = trimToUndefined(url);

  if (!normalizedUrl) {
    return {
      config,
      url: undefined,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return {
      config,
      url: normalizedUrl,
    };
  }

  if (
    (parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:") &&
    isLoopbackHostname(parsedUrl.hostname)
  ) {
    const resolvedPort = Number.parseInt(parsedUrl.port, 10);
    const port = Number.isFinite(resolvedPort)
      ? resolvedPort
      : parsedUrl.protocol === "wss:"
        ? 443
        : 80;

    const localConfig: OpenClawConfig = {
        ...config,
        gateway: {
          ...config.gateway,
          mode: "local",
          port,
          tls: {
            ...config.gateway?.tls,
            enabled: parsedUrl.protocol === "wss:",
          },
        },
      };

    return {
      config: localConfig,
      url: undefined,
    };
  }

  return {
    config,
    url: normalizedUrl,
  };
}

function createGatewayCallBase(
  options: OnboardingHelperOptions,
  deps: OnboardingHelperDeps,
) {
  const gatewayTarget = resolveGatewayTarget(options.url, deps);

  return {
    config: gatewayTarget.config,
    url: gatewayTarget.url,
    timeoutMs: options.timeoutMs,
    token: trimToUndefined(options.token),
    password: trimToUndefined(options.password),
    configPath: trimToUndefined(options.configPath),
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "Jarvis Desktop",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.CLI,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
  };
}

function normalizePairingResolution(
  resolution: PairingSetupResolution,
  deps: OnboardingHelperDeps,
): OnboardingPairingPayload {
  if (!resolution.ok) {
    return {
      url: null,
      token: null,
      password: null,
      authLabel: null,
      urlSource: null,
      setupCode: null,
      error: resolution.error,
    };
  }

  const payload = {
    url: resolution.payload.url,
    token: resolution.authLabel === "token" ? trimToNull(resolution.payload.bootstrapToken) : null,
    password:
      resolution.authLabel === "password" ? trimToNull(resolution.payload.bootstrapToken) : null,
    authLabel: resolution.authLabel,
    urlSource: resolution.urlSource,
    setupCode: deps.encodePairingSetupCode(resolution.payload),
    error: null,
  };

  if (isUnsafeRemotePairingUrl(payload.url)) {
    return {
      ...payload,
      error: getUnsafeRemotePairingMessage(payload.url),
    };
  }

  return payload;
}

async function resolvePairingPayload(
  options: OnboardingHelperOptions,
  deps: OnboardingHelperDeps,
): Promise<OnboardingPairingPayload> {
  const gatewayTarget = resolveGatewayTarget(options.url, deps);
  const resolution = await deps.resolvePairingSetupFromConfig(gatewayTarget.config, {
    preferRemoteUrl: true,
    runCommandWithTimeout: deps.runCommandWithTimeout,
  });

  return normalizePairingResolution(resolution, deps);
}

async function verifyGatewayReachable(
  options: OnboardingHelperOptions,
  deps: OnboardingHelperDeps,
): Promise<{ checkedAt: string; gatewayUrl: string | null }> {
  const checkedAt = new Date().toISOString();
  const gatewayTarget = resolveGatewayTarget(options.url, deps);

  await deps.callGatewayScoped({
    method: "health",
    params: { probe: true },
    scopes: [READ_SCOPE],
    ...createGatewayCallBase(options, deps),
  });

  return {
    checkedAt,
    gatewayUrl: gatewayTarget.url ?? trimToNull(options.url),
  };
}

function normalizeWizardResult(
  action:
    | "start-wizard"
    | "answer-wizard"
    | "get-wizard-status"
    | "cancel-wizard",
  result: WizardStartResult | WizardNextResult,
  sessionId?: string,
) {
  return {
    action,
    sessionId: typeof sessionId === "string" ? sessionId : "sessionId" in result ? result.sessionId : null,
    done: result.done,
    status: result.status ?? null,
    error: typeof result.error === "string" ? result.error : null,
    step: result.step ?? null,
  };
}

export async function probeOnboarding(
  options: OnboardingHelperOptions = {},
  deps: OnboardingHelperDeps = defaultDeps,
): Promise<OnboardingProbeSnapshot> {
  const gateway = await verifyGatewayReachable(options, deps);
  const pairing = await resolvePairingPayload(options, deps);

  return {
    action: "probe-onboarding",
    checkedAt: gateway.checkedAt,
    gatewayUrl: gateway.gatewayUrl,
    gatewayReachable: true,
    pairing,
  };
}

export async function startWizardSession(
  options: OnboardingHelperOptions = {},
  deps: OnboardingHelperDeps = defaultDeps,
) {
  const result = await deps.callGatewayScoped<WizardStartResult>({
    method: "wizard.start",
    params: {
      mode: "local",
    },
    ...createGatewayCallBase(options, deps),
    scopes: [ADMIN_SCOPE],
  });

  return normalizeWizardResult("start-wizard", result);
}

export async function answerWizardSession(
  sessionId: string,
  answer: OnboardingWizardAnswer,
  options: OnboardingHelperOptions = {},
  deps: OnboardingHelperDeps = defaultDeps,
) {
  const result = await deps.callGatewayScoped<WizardNextResult>({
    method: "wizard.next",
    params: {
      sessionId,
      answer: {
        stepId: answer.stepId,
        value: answer.value,
      },
    },
    ...createGatewayCallBase(options, deps),
    scopes: [ADMIN_SCOPE],
  });

  return normalizeWizardResult("answer-wizard", result, sessionId);
}

export async function getWizardSessionStatus(
  sessionId: string,
  options: OnboardingHelperOptions = {},
  deps: OnboardingHelperDeps = defaultDeps,
) {
  const result = await deps.callGatewayScoped<WizardStatusResult>({
    method: "wizard.status",
    params: {
      sessionId,
    },
    ...createGatewayCallBase(options, deps),
    scopes: [ADMIN_SCOPE],
  });

  return {
    action: "get-wizard-status",
    sessionId,
    done: result.status !== "running",
    status: result.status ?? null,
    error: typeof result.error === "string" ? result.error : null,
    step: null,
  };
}

export async function cancelWizardSession(
  sessionId: string,
  options: OnboardingHelperOptions = {},
  deps: OnboardingHelperDeps = defaultDeps,
) {
  const result: { status?: string; error?: string } = await deps.callGatewayScoped({
    method: "wizard.cancel",
    params: {
      sessionId,
    },
    ...createGatewayCallBase(options, deps),
    scopes: [ADMIN_SCOPE],
  });

  return {
    action: "cancel-wizard",
    sessionId,
    done: true,
    status: typeof result.status === "string" ? result.status : null,
    error: typeof result.error === "string" ? result.error : null,
    step: null,
  };
}

export async function getPairingSetup(
  options: OnboardingHelperOptions = {},
  deps: OnboardingHelperDeps = defaultDeps,
): Promise<OnboardingPairingSnapshot> {
  const gateway = await verifyGatewayReachable(options, deps);
  const pairing = await resolvePairingPayload(options, deps);

  return {
    action: "get-pairing-setup",
    checkedAt: gateway.checkedAt,
    gatewayUrl: gateway.gatewayUrl,
    gatewayReachable: true,
    pairing,
    verified: false,
  };
}

export async function completePairing(
  input: {
    url: string;
    token?: string | null;
    password?: string | null;
    setupCode?: string | null;
  },
  options: OnboardingHelperOptions = {},
  deps: OnboardingHelperDeps = defaultDeps,
): Promise<OnboardingPairingSnapshot> {
  const pairingUrl = trimToUndefined(input?.url);

  if (!pairingUrl) {
    throw new Error("Pairing URL is required.");
  }

  const token = trimToUndefined(input?.token);
  const password = trimToUndefined(input?.password);

  await deps.callGatewayScoped({
    method: "health",
    params: { probe: true },
    scopes: [READ_SCOPE],
    ...createGatewayCallBase(
      {
        ...options,
        url: pairingUrl,
        token,
        password,
      },
        deps,
      ),
  });

  const checkedAt = new Date().toISOString();
  const setupCode =
    trimToUndefined(input?.setupCode) ??
    deps.encodePairingSetupCode({
      url: pairingUrl,
      bootstrapToken: token ?? password ?? "",
    });

  return {
    action: "complete-pairing",
    checkedAt,
    gatewayUrl: pairingUrl,
    gatewayReachable: true,
    pairing: {
      url: pairingUrl,
      token: token ?? null,
      password: password ?? null,
      authLabel: token ? "token" : password ? "password" : null,
      urlSource: "pairing-input",
      setupCode,
      error: null,
    },
    verified: true,
  };
}
