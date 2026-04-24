import path from "node:path";
import { hasBinary } from "../agents/skills.js";
import {
  CONFIG_PATH,
  loadConfig,
  readConfigFileSnapshot,
  type HooksGmailTailscaleMode,
} from "../config/config.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_TOPIC,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
} from "../hooks/gmail.js";
import { callGatewayScoped } from "./call.js";
import { READ_SCOPE } from "./method-scopes.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";

export type GmailHookHelperOptions = {
  url?: string;
  timeoutMs?: number;
  token?: string;
  password?: string;
  configPath?: string;
};

export type GmailHookSetupInput = {
  account: string;
  project?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  tailscaleMode?: HooksGmailTailscaleMode;
};

export type GmailHookState = "missing" | "configured" | "ready" | "error";

export type GmailHookDependencyStatus = {
  id: "gcloud" | "gog" | "tailscale";
  label: string;
  required: boolean;
  available: boolean;
  ready: boolean;
  message: string | null;
};

export type GmailHookStatusSnapshot = {
  action: "probe-gmail-hook" | "apply-gmail-setup";
  checkedAt: string;
  gatewayUrl: string | null;
  configPath: string;
  source: string;
  state: GmailHookState;
  message: string | null;
  warning: string | null;
  gatewayReachable: boolean;
  account: string | null;
  project: string | null;
  label: string;
  topic: string;
  subscription: string;
  tailscaleMode: HooksGmailTailscaleMode;
  dependencies: GmailHookDependencyStatus[];
};

type GmailHookHelperDeps = {
  callGatewayScoped: typeof callGatewayScoped;
  hasBinary: typeof hasBinary;
  loadConfig: typeof loadConfig;
  readConfigFileSnapshot: typeof readConfigFileSnapshot;
  resolveGmailHookRuntimeConfig: typeof resolveGmailHookRuntimeConfig;
  runCommandWithTimeout: typeof runCommandWithTimeout;
  runSetupCommand: typeof runSetupCommand;
};

const defaultDeps: GmailHookHelperDeps = {
  callGatewayScoped,
  hasBinary,
  loadConfig,
  readConfigFileSnapshot,
  resolveGmailHookRuntimeConfig,
  runCommandWithTimeout,
  runSetupCommand,
};

const DEFAULT_TAILSCALE_MODE: HooksGmailTailscaleMode = "funnel";

class GmailHookHelperError extends Error {
  code: string;

  details: Record<string, unknown> | null;

  constructor(
    message: string,
    options: {
      code?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GmailHookHelperError";
    this.code = options.code ?? "gmail_hook_failed";
    this.details = options.details ?? null;
  }
}

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

function resolveGatewayTarget(
  options: GmailHookHelperOptions,
  deps: GmailHookHelperDeps,
) {
  const config = deps.loadConfig();
  const normalizedUrl = trimToUndefined(options.url);

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

    return {
      config: {
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
      },
      url: undefined,
    };
  }

  return {
    config,
    url: normalizedUrl,
  };
}

function createDependencyStatus(params: {
  id: GmailHookDependencyStatus["id"];
  label: string;
  required: boolean;
  available: boolean;
  ready: boolean;
  message?: string | null;
}): GmailHookDependencyStatus {
  return {
    id: params.id,
    label: params.label,
    required: params.required,
    available: params.available,
    ready: params.ready,
    message: params.message ?? null,
  };
}

function createDefaultCoreConfig(): Omit<
  GmailHookStatusSnapshot,
  | "action"
  | "checkedAt"
  | "gatewayUrl"
  | "configPath"
  | "source"
  | "state"
  | "message"
  | "warning"
  | "gatewayReachable"
  | "dependencies"
> {
  return {
    account: null,
    project: null,
    label: DEFAULT_GMAIL_LABEL,
    topic: DEFAULT_GMAIL_TOPIC,
    subscription: DEFAULT_GMAIL_SUBSCRIPTION,
    tailscaleMode: DEFAULT_TAILSCALE_MODE,
  };
}

async function probeGcloudAuth(deps: GmailHookHelperDeps) {
  if (!deps.hasBinary("gcloud")) {
    return createDependencyStatus({
      id: "gcloud",
      label: "gcloud",
      required: true,
      available: false,
      ready: false,
      message: "gcloud binary not found.",
    });
  }

  const result = await deps.runCommandWithTimeout(
    [
      "gcloud",
      "auth",
      "list",
      "--filter",
      "status:ACTIVE",
      "--format",
      "value(account)",
    ],
    { timeoutMs: 30_000 },
  );

  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout || "gcloud auth list failed").trim();
    return createDependencyStatus({
      id: "gcloud",
      label: "gcloud",
      required: true,
      available: true,
      ready: false,
      message: reason,
    });
  }

  const account = result.stdout.trim().split(/\s+/)[0];

  if (!account) {
    return createDependencyStatus({
      id: "gcloud",
      label: "gcloud",
      required: true,
      available: true,
      ready: false,
      message: "No active gcloud account. Run gcloud auth login first.",
    });
  }

  return createDependencyStatus({
    id: "gcloud",
    label: "gcloud",
    required: true,
    available: true,
    ready: true,
    message: `Authenticated as ${account}.`,
  });
}

async function probeGogAuth(deps: GmailHookHelperDeps) {
  if (!deps.hasBinary("gog")) {
    return createDependencyStatus({
      id: "gog",
      label: "gog",
      required: true,
      available: false,
      ready: false,
      message: "gog binary not found.",
    });
  }

  const result = await deps.runCommandWithTimeout(["gog", "auth", "status", "--json"], {
    timeoutMs: 30_000,
  });

  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout || "gog auth status failed").trim();
    return createDependencyStatus({
      id: "gog",
      label: "gog",
      required: true,
      available: true,
      ready: false,
      message: reason,
    });
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      account?: {
        credentials_exists?: boolean;
        email?: string;
      };
      config?: {
        exists?: boolean;
      };
    };

    const hasCredentials =
      parsed.account?.credentials_exists === true || parsed.config?.exists === true;
    const email = trimToUndefined(parsed.account?.email);

    if (!hasCredentials) {
      return createDependencyStatus({
        id: "gog",
        label: "gog",
        required: true,
        available: true,
        ready: false,
        message: "No gog OAuth client configured. Run gog auth credentials first.",
      });
    }

    if (!email) {
      return createDependencyStatus({
        id: "gog",
        label: "gog",
        required: true,
        available: true,
        ready: false,
        message: "No gog account authorized. Run gog auth add first.",
      });
    }

    return createDependencyStatus({
      id: "gog",
      label: "gog",
      required: true,
      available: true,
      ready: true,
      message: `Authorized as ${email}.`,
    });
  } catch (error) {
    return createDependencyStatus({
      id: "gog",
      label: "gog",
      required: true,
      available: true,
      ready: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function probeTailscaleStatus(
  required: boolean,
  deps: GmailHookHelperDeps,
) {
  if (!deps.hasBinary("tailscale")) {
    return createDependencyStatus({
      id: "tailscale",
      label: "tailscale",
      required,
      available: false,
      ready: !required,
      message: required ? "tailscale binary not found." : null,
    });
  }

  if (!required) {
    return createDependencyStatus({
      id: "tailscale",
      label: "tailscale",
      required: false,
      available: true,
      ready: true,
      message: null,
    });
  }

  const result = await deps.runCommandWithTimeout(["tailscale", "status", "--json"], {
    timeoutMs: 30_000,
  });

  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout || "tailscale status failed").trim();
    return createDependencyStatus({
      id: "tailscale",
      label: "tailscale",
      required: true,
      available: true,
      ready: false,
      message: reason,
    });
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      BackendState?: string;
      CurrentTailnet?: { Name?: string };
      Self?: { DNSName?: string };
      Health?: string[];
    };

    const backendState = trimToUndefined(parsed.BackendState);
    const dnsName = trimToUndefined(parsed.Self?.DNSName);
    const tailnetName = trimToUndefined(parsed.CurrentTailnet?.Name);

    if (!backendState || backendState === "NeedsLogin" || backendState === "Stopped") {
      return createDependencyStatus({
        id: "tailscale",
        label: "tailscale",
        required: true,
        available: true,
        ready: false,
        message:
          trimToUndefined(parsed.Health?.[0]) ??
          "Tailscale is not logged in. Run tailscale up first.",
      });
    }

    if (!dnsName && !tailnetName) {
      return createDependencyStatus({
        id: "tailscale",
        label: "tailscale",
        required: true,
        available: true,
        ready: false,
        message: "Tailscale is running but DNS/tailnet identity is missing.",
      });
    }

    return createDependencyStatus({
      id: "tailscale",
      label: "tailscale",
      required: true,
      available: true,
      ready: true,
      message: tailnetName
        ? `Connected to tailnet ${tailnetName}.`
        : "Tailscale is logged in and reachable.",
    });
  } catch (error) {
    return createDependencyStatus({
      id: "tailscale",
      label: "tailscale",
      required: true,
      available: true,
      ready: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function probeGatewayReachability(
  options: GmailHookHelperOptions,
  deps: GmailHookHelperDeps,
) {
  const target = resolveGatewayTarget(options, deps);

  try {
    await deps.callGatewayScoped({
      method: "health",
      params: { probe: true },
      scopes: [READ_SCOPE],
      config: target.config,
      url: target.url,
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
    });

    return { reachable: true, message: null };
  } catch (error) {
    return {
      reachable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSnapshot(params: {
  action: GmailHookStatusSnapshot["action"];
  gatewayUrl: string | null;
  state: GmailHookState;
  message?: string | null;
  warning?: string | null;
  gatewayReachable: boolean;
  config: ReturnType<typeof createDefaultCoreConfig>;
  dependencies: GmailHookDependencyStatus[];
}): GmailHookStatusSnapshot {
  return {
    action: params.action,
    checkedAt: new Date().toISOString(),
    gatewayUrl: params.gatewayUrl,
    configPath: CONFIG_PATH,
    source: "openclaw-gmail-hook",
    state: params.state,
    message: params.message ?? null,
    warning: params.warning ?? null,
    gatewayReachable: params.gatewayReachable,
    account: params.config.account,
    project: params.config.project,
    label: params.config.label,
    topic: params.config.topic,
    subscription: params.config.subscription,
    tailscaleMode: params.config.tailscaleMode,
    dependencies: params.dependencies,
  };
}

function getDependencyFailureMessage(dependencies: GmailHookDependencyStatus[]) {
  const failing = dependencies.find(
    (dependency) => dependency.required && (!dependency.available || !dependency.ready),
  );

  return failing?.message ?? `${failing?.label ?? "Required dependency"} is unavailable.`;
}

function normalizeInput(input: GmailHookSetupInput): GmailHookSetupInput {
  const account = trimToUndefined(input.account);
  const label = trimToUndefined(input.label) ?? DEFAULT_GMAIL_LABEL;
  const topic = trimToUndefined(input.topic) ?? DEFAULT_GMAIL_TOPIC;
  const subscription =
    trimToUndefined(input.subscription) ?? DEFAULT_GMAIL_SUBSCRIPTION;
  const tailscaleMode =
    input.tailscaleMode === "off" ||
    input.tailscaleMode === "serve" ||
    input.tailscaleMode === "funnel"
      ? input.tailscaleMode
      : DEFAULT_TAILSCALE_MODE;

  if (!account) {
    throw new GmailHookHelperError("Gmail account is required.", {
      code: "invalid_request",
    });
  }

  return {
    account,
    project: trimToUndefined(input.project),
    label,
    topic,
    subscription,
    tailscaleMode,
  };
}

async function buildDependencies(
  tailscaleMode: HooksGmailTailscaleMode,
  deps: GmailHookHelperDeps,
) {
  const dependencies = [
    await probeGcloudAuth(deps),
    await probeGogAuth(deps),
  ];

  dependencies.push(await probeTailscaleStatus(tailscaleMode !== "off", deps));

  return dependencies;
}

async function runSetupCommand(
  input: GmailHookSetupInput,
  options: GmailHookHelperOptions,
  deps: GmailHookHelperDeps,
) {
  const repoRoot = process.cwd();
  const entryPoint = path.join(repoRoot, "openclaw.mjs");
  const args = [
    process.execPath,
    entryPoint,
    "--dev",
    "webhooks",
    "gmail",
    "setup",
    "--account",
    input.account,
    "--label",
    input.label ?? DEFAULT_GMAIL_LABEL,
    "--topic",
    input.topic ?? DEFAULT_GMAIL_TOPIC,
    "--subscription",
    input.subscription ?? DEFAULT_GMAIL_SUBSCRIPTION,
    "--tailscale",
    input.tailscaleMode ?? DEFAULT_TAILSCALE_MODE,
    "--json",
  ];

  if (input.project) {
    args.push("--project", input.project);
  }

  const result = await deps.runCommandWithTimeout(args, {
    timeoutMs: options.timeoutMs ?? 120_000,
  });

  if (result.code !== 0) {
    throw new GmailHookHelperError(
      (result.stderr || result.stdout || "Gmail hook setup failed").trim(),
      {
        code: "command_failed",
        details: {
          command: args.join(" "),
        },
      },
    );
  }
}

export async function probeGmailHook(
  options: GmailHookHelperOptions = {},
  deps: GmailHookHelperDeps = defaultDeps,
): Promise<GmailHookStatusSnapshot> {
  const gatewayUrl = trimToNull(options.url);
  const defaultConfig = createDefaultCoreConfig();
  const configSnapshot = await deps.readConfigFileSnapshot();

  if (!configSnapshot.valid) {
    return buildSnapshot({
      action: "probe-gmail-hook",
      gatewayUrl,
      state: "error",
      message: `OpenClaw config is invalid at ${CONFIG_PATH}.`,
      warning: null,
      gatewayReachable: false,
      config: defaultConfig,
      dependencies: await buildDependencies(defaultConfig.tailscaleMode, deps),
    });
  }

  const config = configSnapshot.config;
  const rawGmail = config.hooks?.gmail;
  const hasGmailConfig = Boolean(rawGmail && Object.keys(rawGmail).length > 0);
  const resolved = deps.resolveGmailHookRuntimeConfig(config, {});

  if (!hasGmailConfig) {
    return buildSnapshot({
      action: "probe-gmail-hook",
      gatewayUrl,
      state: "missing",
      message: "Gmail hook is not configured in the local OpenClaw config.",
      warning: null,
      gatewayReachable: false,
      config: defaultConfig,
      dependencies: await buildDependencies(defaultConfig.tailscaleMode, deps),
    });
  }

  const configCore = resolved.ok
    ? {
        account: resolved.value.account,
        project: parseTopicPath(resolved.value.topic)?.projectId ?? null,
        label: resolved.value.label,
        topic: resolved.value.topic,
        subscription: resolved.value.subscription,
        tailscaleMode: resolved.value.tailscale.mode,
      }
    : {
        account: trimToNull(rawGmail?.account),
        project: parseTopicPath(trimToUndefined(rawGmail?.topic) ?? "")?.projectId ?? null,
        label: trimToUndefined(rawGmail?.label) ?? DEFAULT_GMAIL_LABEL,
        topic: trimToUndefined(rawGmail?.topic) ?? DEFAULT_GMAIL_TOPIC,
        subscription:
          trimToUndefined(rawGmail?.subscription) ?? DEFAULT_GMAIL_SUBSCRIPTION,
        tailscaleMode:
          rawGmail?.tailscale?.mode === "off" ||
          rawGmail?.tailscale?.mode === "serve" ||
          rawGmail?.tailscale?.mode === "funnel"
            ? rawGmail.tailscale.mode
            : DEFAULT_TAILSCALE_MODE,
      };

  const dependencies = await buildDependencies(configCore.tailscaleMode, deps);

  if (!resolved.ok) {
    return buildSnapshot({
      action: "probe-gmail-hook",
      gatewayUrl,
      state: "error",
      message: resolved.error,
      warning: null,
      gatewayReachable: false,
      config: configCore,
      dependencies,
    });
  }

  const hasDependencyFailure = dependencies.some(
    (dependency) => dependency.required && (!dependency.available || !dependency.ready),
  );

  if (hasDependencyFailure) {
    return buildSnapshot({
      action: "probe-gmail-hook",
      gatewayUrl,
      state: "error",
      message: getDependencyFailureMessage(dependencies),
      warning: null,
      gatewayReachable: false,
      config: configCore,
      dependencies,
    });
  }

  const gatewayStatus = await probeGatewayReachability(options, deps);

  if (!gatewayStatus.reachable) {
    return buildSnapshot({
      action: "probe-gmail-hook",
      gatewayUrl,
      state: "configured",
      message:
        "Gmail hook config is present, but runtime readiness is not fully confirmed.",
      warning: gatewayStatus.message,
      gatewayReachable: false,
      config: configCore,
      dependencies,
    });
  }

  return buildSnapshot({
    action: "probe-gmail-hook",
    gatewayUrl,
    state: "ready",
    message: "Gmail hook is configured and the OpenClaw gateway is reachable.",
    warning: "Email delivery is not end-to-end verified in this milestone.",
    gatewayReachable: true,
    config: configCore,
    dependencies,
  });
}

export async function applyGmailSetup(
  input: GmailHookSetupInput,
  options: GmailHookHelperOptions = {},
  deps: GmailHookHelperDeps = defaultDeps,
): Promise<GmailHookStatusSnapshot> {
  const normalizedInput = normalizeInput(input);
  const dependencies = await buildDependencies(
    normalizedInput.tailscaleMode ?? DEFAULT_TAILSCALE_MODE,
    deps,
  );

  if (
    dependencies.some(
      (dependency) => dependency.required && (!dependency.available || !dependency.ready),
    )
  ) {
    throw new GmailHookHelperError(getDependencyFailureMessage(dependencies), {
      code: "prerequisite_failed",
      details: {
        dependencies,
      },
    });
  }

  await deps.runSetupCommand(normalizedInput, options, deps);
  return await probeGmailHook(options, deps);
}
