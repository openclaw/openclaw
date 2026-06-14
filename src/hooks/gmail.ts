// Gmail hook helpers manage Gmail OAuth setup and watcher launch state.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  type OpenClawConfig,
  DEFAULT_GATEWAY_PORT,
  type HooksGmailDeliveryMode,
  type HooksGmailTailscaleMode,
  resolveGatewayPort,
} from "../config/config.js";
import { resolveExecutable } from "../infra/executable-path.js";
import { getWindowsInstallRoots } from "../infra/windows-install-roots.js";

export const DEFAULT_GMAIL_LABEL = "INBOX";
export const DEFAULT_GMAIL_TOPIC = "gog-gmail-watch";
export const DEFAULT_GMAIL_SUBSCRIPTION = "gog-gmail-watch-push";
export const DEFAULT_GMAIL_SERVE_BIND = "127.0.0.1";
export const DEFAULT_GMAIL_SERVE_PORT = 8788;
export const DEFAULT_GMAIL_SERVE_PATH = "/gmail-pubsub";
export const DEFAULT_GMAIL_MAX_BYTES = 20_000;
export const DEFAULT_GMAIL_RENEW_MINUTES = 12 * 60;
const DEFAULT_HOOKS_PATH = "/hooks";
const GMAIL_WATCH_SENSITIVE_FLAGS = new Set(["--token", "--hook-url", "--hook-token"]);
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;
let gogBin: string | undefined;

export type GmailHookOverrides = {
  account?: string;
  deliveryMode?: HooksGmailDeliveryMode;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  serveBind?: string;
  servePort?: number;
  servePath?: string;
  tailscaleMode?: HooksGmailTailscaleMode;
  tailscalePath?: string;
  tailscaleTarget?: string;
};

export type GmailHookBaseRuntimeConfig = {
  account: string;
  label: string;
  topic: string;
  subscription: string;
  hookToken: string;
  hookUrl: string;
  includeBody: boolean;
  maxBytes: number;
  renewEveryMinutes: number;
};

export type GmailHookPushRuntimeConfig = GmailHookBaseRuntimeConfig & {
  delivery: {
    mode: "push";
    subscription: string;
  };
  pushToken: string;
  serve: {
    bind: string;
    port: number;
    path: string;
  };
  tailscale: {
    mode: HooksGmailTailscaleMode;
    path: string;
    target?: string;
  };
};

export type GmailHookPullRuntimeConfig = GmailHookBaseRuntimeConfig & {
  delivery: {
    mode: "pull";
    subscription: string;
  };
};

export type GmailHookRuntimeConfig = GmailHookPushRuntimeConfig | GmailHookPullRuntimeConfig;

export function isGmailHookPushRuntimeConfig(
  cfg: GmailHookRuntimeConfig,
): cfg is GmailHookPushRuntimeConfig {
  return cfg.delivery.mode === "push";
}

export function isGmailHookPullRuntimeConfig(
  cfg: GmailHookRuntimeConfig,
): cfg is GmailHookPullRuntimeConfig {
  return cfg.delivery.mode === "pull";
}

export function generateHookToken(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

export function mergeHookPresets(existing: string[] | undefined, preset: string): string[] {
  const next = new Set(normalizeUniqueStringEntries(existing));
  next.add(preset);
  return Array.from(next);
}

export function normalizeHooksPath(raw?: string): string {
  const base = raw?.trim() || DEFAULT_HOOKS_PATH;
  if (base === "/") {
    return DEFAULT_HOOKS_PATH;
  }
  const withSlash = base.startsWith("/") ? base : `/${base}`;
  return withSlash.replace(/\/+$/, "");
}

export function normalizeServePath(raw?: string): string {
  const base = raw?.trim() || DEFAULT_GMAIL_SERVE_PATH;
  // Tailscale funnel/serve strips the set-path prefix before proxying.
  // To accept requests at /<path> externally, gog must listen on "/".
  if (base === "/") {
    return "/";
  }
  const withSlash = base.startsWith("/") ? base : `/${base}`;
  return withSlash.replace(/\/+$/, "");
}

export function buildDefaultHookUrl(
  hooksPath?: string,
  port: number = DEFAULT_GATEWAY_PORT,
): string {
  const basePath = normalizeHooksPath(hooksPath);
  const baseUrl = `http://127.0.0.1:${port}`;
  return joinUrl(baseUrl, `${basePath}/gmail`);
}

export function resolveGmailHookRuntimeConfig(
  cfg: OpenClawConfig,
  overrides: GmailHookOverrides,
): { ok: true; value: GmailHookRuntimeConfig } | { ok: false; error: string } {
  const hooks = cfg.hooks;
  const gmail = hooks?.gmail;
  const hookToken = overrides.hookToken ?? hooks?.token ?? "";
  if (!hookToken) {
    return { ok: false, error: "hooks.token missing (needed for gmail hook)" };
  }

  const account = overrides.account ?? gmail?.account ?? "";
  if (!account) {
    return { ok: false, error: "gmail account required" };
  }

  const topic = overrides.topic ?? gmail?.topic ?? "";
  if (!topic) {
    return { ok: false, error: "gmail topic required" };
  }

  const deliveryMode = overrides.deliveryMode ?? gmail?.delivery?.mode ?? "push";
  const configuredSubscription =
    overrides.subscription ?? gmail?.delivery?.subscription ?? gmail?.subscription;

  const hookUrl =
    overrides.hookUrl ??
    gmail?.hookUrl ??
    buildDefaultHookUrl(hooks?.path, resolveGatewayPort(cfg));

  const includeBody = overrides.includeBody ?? gmail?.includeBody ?? true;

  const maxBytesRaw = overrides.maxBytes ?? gmail?.maxBytes;
  const maxBytes =
    typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
      ? Math.floor(maxBytesRaw)
      : DEFAULT_GMAIL_MAX_BYTES;

  const renewEveryMinutesRaw = overrides.renewEveryMinutes ?? gmail?.renewEveryMinutes;
  const renewEveryMinutes =
    typeof renewEveryMinutesRaw === "number" &&
    Number.isFinite(renewEveryMinutesRaw) &&
    renewEveryMinutesRaw > 0
      ? Math.floor(renewEveryMinutesRaw)
      : DEFAULT_GMAIL_RENEW_MINUTES;

  const label = overrides.label ?? gmail?.label ?? DEFAULT_GMAIL_LABEL;
  const baseRuntimeConfig = {
    account,
    label,
    topic,
    hookToken,
    hookUrl,
    includeBody,
    maxBytes,
    renewEveryMinutes,
  };

  if (deliveryMode === "pull") {
    if (!configuredSubscription) {
      return { ok: false, error: "gmail pull subscription required" };
    }
    const subscriptionPath = parseSubscriptionPath(configuredSubscription);
    if (!subscriptionPath) {
      return {
        ok: false,
        error:
          "gmail pull subscription must be a full Pub/Sub path (projects/<project>/subscriptions/<subscription>)",
      };
    }
    return {
      ok: true,
      value: {
        ...baseRuntimeConfig,
        subscription: configuredSubscription,
        delivery: {
          mode: "pull",
          subscription: configuredSubscription,
        },
      },
    };
  }

  const subscription = configuredSubscription ?? DEFAULT_GMAIL_SUBSCRIPTION;

  const pushToken = overrides.pushToken ?? gmail?.pushToken ?? "";
  if (!pushToken) {
    return { ok: false, error: "gmail push token required" };
  }

  const serveBind = overrides.serveBind ?? gmail?.serve?.bind ?? DEFAULT_GMAIL_SERVE_BIND;
  const servePortRaw = overrides.servePort ?? gmail?.serve?.port;
  const servePort =
    typeof servePortRaw === "number" && Number.isFinite(servePortRaw) && servePortRaw > 0
      ? Math.floor(servePortRaw)
      : DEFAULT_GMAIL_SERVE_PORT;
  const servePathRaw = overrides.servePath ?? gmail?.serve?.path;
  const normalizedServePathRaw =
    typeof servePathRaw === "string" && servePathRaw.trim().length > 0
      ? normalizeServePath(servePathRaw)
      : DEFAULT_GMAIL_SERVE_PATH;
  const tailscaleTargetRaw = overrides.tailscaleTarget ?? gmail?.tailscale?.target;

  const tailscaleMode = overrides.tailscaleMode ?? gmail?.tailscale?.mode ?? "off";
  const tailscaleTarget =
    tailscaleMode !== "off" &&
    typeof tailscaleTargetRaw === "string" &&
    tailscaleTargetRaw.trim().length > 0
      ? tailscaleTargetRaw.trim()
      : undefined;
  // Tailscale strips the public path before proxying, so listen on "/" when on.
  const servePath = normalizeServePath(
    tailscaleMode !== "off" && !tailscaleTarget ? "/" : normalizedServePathRaw,
  );

  const tailscalePathRaw = overrides.tailscalePath ?? gmail?.tailscale?.path;
  const tailscalePath = normalizeServePath(
    tailscaleMode !== "off"
      ? (tailscalePathRaw ?? normalizedServePathRaw)
      : (tailscalePathRaw ?? servePath),
  );

  return {
    ok: true,
    value: {
      ...baseRuntimeConfig,
      subscription,
      delivery: {
        mode: "push",
        subscription,
      },
      pushToken,
      serve: {
        bind: serveBind,
        port: servePort,
        path: servePath,
      },
      tailscale: {
        mode: tailscaleMode,
        path: tailscalePath,
        target: tailscaleTarget,
      },
    },
  };
}

export function buildGogWatchStartArgs(
  cfg: Pick<GmailHookBaseRuntimeConfig, "account" | "label" | "topic">,
): string[] {
  return [
    "gmail",
    "watch",
    "start",
    "--account",
    cfg.account,
    "--label",
    cfg.label,
    "--topic",
    cfg.topic,
  ];
}

export function buildGogWatchServeArgs(cfg: GmailHookPushRuntimeConfig): string[] {
  const args = [
    "gmail",
    "watch",
    "serve",
    "--account",
    cfg.account,
    "--bind",
    cfg.serve.bind,
    "--port",
    String(cfg.serve.port),
    "--path",
    cfg.serve.path,
    "--token",
    cfg.pushToken,
    "--hook-url",
    cfg.hookUrl,
    "--hook-token",
    cfg.hookToken,
  ];
  if (cfg.includeBody) {
    args.push("--include-body");
  }
  if (cfg.maxBytes > 0) {
    args.push("--max-bytes", String(cfg.maxBytes));
  }
  return args;
}

export function buildGogWatchPullArgs(cfg: GmailHookPullRuntimeConfig): string[] {
  const args = [
    "gmail",
    "watch",
    "pull",
    "--account",
    cfg.account,
    "--subscription",
    cfg.delivery.subscription,
    "--hook-url",
    cfg.hookUrl,
    "--hook-token",
    cfg.hookToken,
  ];
  if (cfg.includeBody) {
    args.push("--include-body");
  }
  if (cfg.maxBytes > 0) {
    args.push("--max-bytes", String(cfg.maxBytes));
  }
  return args;
}

export function buildGogWatchPullHelpArgs(): string[] {
  return ["gmail", "watch", "pull", "--help"];
}

function removeGogWatchSensitiveArgs(args: string[]): string[] {
  return args.filter(
    (arg, index, allArgs) =>
      !GMAIL_WATCH_SENSITIVE_FLAGS.has(arg) &&
      !GMAIL_WATCH_SENSITIVE_FLAGS.has(allArgs[index - 1] ?? ""),
  );
}

export function buildGogWatchServeLogArgs(cfg: GmailHookPushRuntimeConfig): string[] {
  return removeGogWatchSensitiveArgs(buildGogWatchServeArgs(cfg));
}

export function buildGogWatchPullLogArgs(cfg: GmailHookPullRuntimeConfig): string[] {
  return removeGogWatchSensitiveArgs(buildGogWatchPullArgs(cfg));
}

export function resolveGogExecutable(): string {
  return (gogBin ??= resolveExecutable("gog"));
}

function escapeForCmdExe(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

export function resolveGogServeInvocation(args: string[]): {
  args: string[];
  command: string;
  windowsHide?: true;
  windowsVerbatimArguments?: true;
} {
  const command = resolveGogExecutable();
  const ext = normalizeLowercaseStringOrEmpty(path.extname(command));
  if (process.platform !== "win32" || (ext !== ".cmd" && ext !== ".bat")) {
    return { command, args, windowsHide: process.platform === "win32" ? true : undefined };
  }
  const cmdExe = path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe");
  return {
    command: cmdExe,
    args: ["/d", "/s", "/c", [command, ...args].map(escapeForCmdExe).join(" ")],
    windowsHide: true,
    windowsVerbatimArguments: true,
  };
}

export function buildTopicPath(projectId: string, topicName: string): string {
  return `projects/${projectId}/topics/${topicName}`;
}

export function parseTopicPath(topic: string): { projectId: string; topicName: string } | null {
  const match = topic.trim().match(/^projects\/([^/]+)\/topics\/([^/]+)$/i);
  if (!match) {
    return null;
  }
  return { projectId: match[1] ?? "", topicName: match[2] ?? "" };
}

export function parseSubscriptionPath(
  subscription: string,
): { projectId: string; subscriptionName: string } | null {
  const match = subscription.trim().match(/^projects\/([^/]+)\/subscriptions\/([^/]+)$/i);
  if (!match) {
    return null;
  }
  return { projectId: match[1] ?? "", subscriptionName: match[2] ?? "" };
}

function joinUrl(base: string, pathLocal: string): string {
  const url = new URL(base);
  const basePath = url.pathname.replace(/\/+$/, "");
  const extra = pathLocal.startsWith("/") ? pathLocal : `/${pathLocal}`;
  url.pathname = `${basePath}${extra}`;
  return url.toString();
}
