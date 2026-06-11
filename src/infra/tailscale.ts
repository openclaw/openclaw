import { existsSync } from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { promptYesNo } from "../cli/prompt.js";
import { danger, info, logVerbose, shouldLogVerbose, warn } from "../globals.js";
import { runExec } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { ensureBinary } from "./binaries.js";

function parsePossiblyNoisyJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

export type TailscaleBackendState = "Running" | "Stopped" | "NeedsLogin" | "Unknown";

export type TailscaleInstallKind = "standalone" | "homebrew" | "app-store" | "path";

export type ResolvedTailscaleClient = {
  binary: string;
  socketPath?: string;
  backendState: TailscaleBackendState;
  dnsName?: string;
  ips: string[];
  installKind: TailscaleInstallKind;
  warnings: string[];
};

export type TailscaleClientOptions = {
  binaryPath?: string | null;
  socketPath?: string | null;
  env?: NodeJS.ProcessEnv;
  allowUnsafeServeReset?: boolean;
};

function normalizePathOption(value: string | null | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function dedupeStrings(values: (string | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePathOption(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function classifyTailscaleInstallKind(binary: string): TailscaleInstallKind {
  if (binary.includes("/opt/homebrew/") || binary.includes("/usr/local/")) {
    return "homebrew";
  }
  if (binary.includes("/Tailscale.app/Contents/MacOS/Tailscale")) {
    return "app-store";
  }
  return binary.includes("/") ? "path" : "standalone";
}

function defaultUserspaceSocketPath(env: NodeJS.ProcessEnv): string | undefined {
  const home = normalizePathOption(env.HOME);
  return home ? `${home}/.local/share/tailscale-userspace/tailscaled.sock` : undefined;
}

function buildTailscaleBinaryCandidates(opts: TailscaleClientOptions): string[] {
  const env = opts.env ?? process.env;
  const forcedTestBinary = getTestTailscaleBinaryOverride(env) ?? undefined;
  return dedupeStrings([
    opts.binaryPath ?? undefined,
    env.OPENCLAW_TAILSCALE_BIN,
    forcedTestBinary,
    "tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ]);
}

function buildTailscaleSocketCandidates(opts: TailscaleClientOptions): (string | undefined)[] {
  const env = opts.env ?? process.env;
  const explicitSocket =
    normalizePathOption(opts.socketPath) ?? normalizePathOption(env.OPENCLAW_TAILSCALE_SOCKET);
  const userspaceSocket = defaultUserspaceSocketPath(env);
  const out: (string | undefined)[] = [];
  if (explicitSocket) {
    out.push(explicitSocket);
  }
  out.push(undefined);
  if (userspaceSocket && existsSync(userspaceSocket)) {
    out.push(userspaceSocket);
  }
  const seen = new Set<string>();
  return out.filter((value) => {
    const key = value ?? "<default>";
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function tailscaleClientArgs(
  client: Pick<ResolvedTailscaleClient, "socketPath">,
  args: string[],
): string[] {
  return client.socketPath ? ["--socket", client.socketPath, ...args] : args;
}

function readTailscaleBackendState(value: unknown): TailscaleBackendState {
  if (value === "Running" || value === "Stopped" || value === "NeedsLogin") {
    return value;
  }
  return "Unknown";
}

function readStatusSelf(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  return typeof parsed.Self === "object" && parsed.Self !== null
    ? (parsed.Self as Record<string, unknown>)
    : undefined;
}

function readStatusDnsName(parsed: Record<string, unknown>): string | undefined {
  const dns = normalizeOptionalString(readStatusSelf(parsed)?.DNSName);
  return dns ? dns.replace(/\.$/, "") : undefined;
}

function readStatusIps(parsed: Record<string, unknown>): string[] {
  const topLevelIps = Array.isArray(parsed.TailscaleIPs) ? parsed.TailscaleIPs : undefined;
  const selfIps = Array.isArray(readStatusSelf(parsed)?.TailscaleIPs)
    ? (readStatusSelf(parsed)?.TailscaleIPs as unknown[])
    : undefined;
  return [...(topLevelIps ?? []), ...(selfIps ?? [])]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function parseTailscaleIpOutput(stdout: string): string[] {
  return stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatTailscaleAttempt(binary: string, socketPath: string | undefined): string {
  return socketPath ? `${binary} --socket ${socketPath}` : `${binary} (default socket)`;
}

export async function resolveTailscaleClient(
  exec: typeof runExec = runExec,
  opts: TailscaleClientOptions = {},
): Promise<ResolvedTailscaleClient> {
  const binaryCandidates = buildTailscaleBinaryCandidates(opts);
  const socketCandidates = buildTailscaleSocketCandidates(opts);
  const warnings: string[] = [];
  const failures: string[] = [];

  for (const binary of binaryCandidates) {
    if (binary.startsWith("/") && !existsSync(binary)) {
      failures.push(`${binary}: not found`);
      continue;
    }
    for (const socketPath of socketCandidates) {
      if (socketPath && !existsSync(socketPath)) {
        failures.push(`${formatTailscaleAttempt(binary, socketPath)}: socket not found`);
        continue;
      }
      const attempt = formatTailscaleAttempt(binary, socketPath);
      try {
        const statusResult = await exec(
          binary,
          tailscaleClientArgs({ socketPath }, ["status", "--json"]),
          { timeoutMs: 5_000, maxBuffer: 400_000 },
        );
        const status = statusResult.stdout ? parsePossiblyNoisyJsonObject(statusResult.stdout) : {};
        const backendState = readTailscaleBackendState(status.BackendState);
        const authUrl = normalizeOptionalString(status.AuthURL);
        if (backendState !== "Running") {
          const loginHint =
            backendState === "NeedsLogin" || authUrl
              ? "login required"
              : `backend state ${backendState}`;
          failures.push(`${attempt}: ${loginHint}`);
          continue;
        }

        const ipResult = await exec(binary, tailscaleClientArgs({ socketPath }, ["ip", "-4"]), {
          timeoutMs: 5_000,
          maxBuffer: 100_000,
        });
        const ips = parseTailscaleIpOutput(ipResult.stdout);
        if (ips.length === 0) {
          failures.push(`${attempt}: no IPv4 address from tailscale ip -4`);
          continue;
        }

        if (failures.length > 0) {
          warnings.push(...failures);
        }
        return {
          binary,
          socketPath,
          backendState,
          dnsName: readStatusDnsName(status),
          ips,
          installKind: classifyTailscaleInstallKind(binary),
          warnings,
        };
      } catch (err) {
        const { stderr, stdout, message } = extractExecErrorText(err);
        const detail = (stderr || stdout || message || "failed").trim();
        failures.push(`${attempt}: ${detail}`);
      }
    }
  }

  throw new Error(
    [
      "No usable Tailscale client found.",
      "OpenClaw requires a Tailscale CLI connected to a running tailscaled daemon.",
      "Set gateway.tailscale.binaryPath / OPENCLAW_TAILSCALE_BIN and gateway.tailscale.socketPath / OPENCLAW_TAILSCALE_SOCKET when using a non-default daemon socket.",
      failures.length > 0 ? `Attempts: ${failures.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Locate Tailscale binary using multiple strategies:
 * 1. PATH lookup (via which command)
 * 2. Known macOS app path
 * 3. find /Applications for Tailscale.app
 * 4. locate database (if available)
 *
 * @returns Path to Tailscale binary or null if not found
 */
export async function findTailscaleBinary(): Promise<string | null> {
  // Helper to check if a binary exists and is executable
  const checkBinary = async (path: string): Promise<boolean> => {
    if (!path || !existsSync(path)) {
      return false;
    }
    try {
      // Use Promise.race with runExec to implement timeout
      await Promise.race([
        runExec(path, ["--version"], { timeoutMs: 3000 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      return true;
    } catch {
      return false;
    }
  };

  // Strategy 1: which command
  try {
    const { stdout } = await runExec("which", ["tailscale"]);
    const fromPath = stdout.trim();
    if (fromPath && (await checkBinary(fromPath))) {
      return fromPath;
    }
  } catch {
    // which failed, continue
  }

  // Strategy 2: Known macOS app path
  const macAppPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  if (await checkBinary(macAppPath)) {
    return macAppPath;
  }

  // Strategy 3: find command in /Applications
  try {
    const { stdout } = await runExec(
      "find",
      [
        "/Applications",
        "-maxdepth",
        "3",
        "-name",
        "Tailscale",
        "-path",
        "*/Tailscale.app/Contents/MacOS/Tailscale",
      ],
      { timeoutMs: 5000 },
    );
    const found = stdout.trim().split("\n")[0];
    if (found && (await checkBinary(found))) {
      return found;
    }
  } catch {
    // find failed, continue
  }

  // Strategy 4: locate command
  try {
    const { stdout } = await runExec("locate", ["Tailscale.app"]);
    const candidates = stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes("/Tailscale.app/Contents/MacOS/Tailscale"));
    for (const candidate of candidates) {
      if (await checkBinary(candidate)) {
        return candidate;
      }
    }
  } catch {
    // locate failed, continue
  }

  return null;
}

export async function getTailnetHostname(
  exec: typeof runExec = runExec,
  detectedBinary?: string | TailscaleClientOptions,
) {
  // Derive tailnet hostname (or IP fallback) from tailscale status JSON.
  const opts =
    typeof detectedBinary === "string" ? { binaryPath: detectedBinary } : (detectedBinary ?? {});
  const client = await resolveTailscaleClient(exec, opts);
  if (client.dnsName) {
    return client.dnsName;
  }
  if (client.ips.length > 0) {
    return client.ips[0];
  }
  throw new Error("Could not determine Tailscale DNS or IP");
}

/**
 * Get the Tailscale binary command to use.
 * Returns a cached detected binary or the default "tailscale" command.
 */
let cachedTailscaleBinary: string | null = null;

export function getTestTailscaleBinaryOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const forcedBinary = env.OPENCLAW_TEST_TAILSCALE_BINARY?.trim();
  if (!forcedBinary) {
    return null;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return forcedBinary;
  }
  return null;
}

async function getTailscaleBinary(): Promise<string> {
  const forcedBinary = getTestTailscaleBinaryOverride();
  if (forcedBinary) {
    cachedTailscaleBinary = forcedBinary;
    return forcedBinary;
  }
  if (cachedTailscaleBinary) {
    return cachedTailscaleBinary;
  }
  cachedTailscaleBinary = await findTailscaleBinary();
  return cachedTailscaleBinary ?? "tailscale";
}

export async function ensureGoInstalled(
  exec: typeof runExec = runExec,
  prompt: typeof promptYesNo = promptYesNo,
  runtime: RuntimeEnv = defaultRuntime,
) {
  // Ensure Go toolchain is present; offer Homebrew install if missing.
  const hasGo = await exec("go", ["version"]).then(
    () => true,
    () => false,
  );
  if (hasGo) {
    return;
  }
  const install = await prompt(
    "Go is not installed. Install via Homebrew (brew install go)?",
    true,
  );
  if (!install) {
    runtime.error("Go is required to build tailscaled from source. Aborting.");
    runtime.exit(1);
  }
  logVerbose("Installing Go via Homebrew…");
  await exec("brew", ["install", "go"]);
}

export async function ensureTailscaledInstalled(
  exec: typeof runExec = runExec,
  prompt: typeof promptYesNo = promptYesNo,
  runtime: RuntimeEnv = defaultRuntime,
) {
  // Ensure tailscaled binary exists; install via Homebrew tailscale if missing.
  const hasTailscaled = await exec("tailscaled", ["--version"]).then(
    () => true,
    () => false,
  );
  if (hasTailscaled) {
    return;
  }

  const install = await prompt(
    "tailscaled not found. Install via Homebrew (tailscale package)?",
    true,
  );
  if (!install) {
    runtime.error("tailscaled is required for user-space funnel. Aborting.");
    runtime.exit(1);
  }
  logVerbose("Installing tailscaled via Homebrew…");
  await exec("brew", ["install", "tailscale"]);
}

type ExecErrorDetails = {
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
  code?: unknown;
};

export type TailscaleWhoisIdentity = {
  login: string;
  name?: string;
};

type TailscaleWhoisCacheEntry = {
  value: TailscaleWhoisIdentity | null;
  expiresAt: number;
};

const whoisCache = new Map<string, TailscaleWhoisCacheEntry>();

function extractExecErrorText(err: unknown) {
  const errOutput = err as ExecErrorDetails;
  const stdout = typeof errOutput.stdout === "string" ? errOutput.stdout : "";
  const stderr = typeof errOutput.stderr === "string" ? errOutput.stderr : "";
  const message = typeof errOutput.message === "string" ? errOutput.message : "";
  const code = typeof errOutput.code === "string" ? errOutput.code : "";
  return { stdout, stderr, message, code };
}

function isPermissionDeniedError(err: unknown): boolean {
  const { stdout, stderr, message, code } = extractExecErrorText(err);
  if (code.toUpperCase() === "EACCES") {
    return true;
  }
  const combined = normalizeLowercaseStringOrEmpty(`${stdout}\n${stderr}\n${message}`);
  return (
    combined.includes("permission denied") ||
    combined.includes("access denied") ||
    combined.includes("operation not permitted") ||
    combined.includes("not permitted") ||
    combined.includes("requires root") ||
    combined.includes("must be run as root") ||
    combined.includes("must be run with sudo") ||
    combined.includes("requires sudo") ||
    combined.includes("need sudo")
  );
}

// Helper to attempt a command, and retry with sudo if it fails.
async function execWithSudoFallback(
  exec: typeof runExec,
  bin: string,
  args: string[],
  opts: { maxBuffer?: number; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec(bin, args, opts);
  } catch (err) {
    if (!isPermissionDeniedError(err)) {
      throw err;
    }
    logVerbose(`Command failed, retrying with sudo: ${bin} ${args.join(" ")}`);
    try {
      return await exec("sudo", ["-n", bin, ...args], opts);
    } catch (sudoErr) {
      const { stderr, message } = extractExecErrorText(sudoErr);
      const detail = (stderr || message).trim();
      if (detail) {
        logVerbose(`Sudo retry failed: ${detail}`);
      }
      throw err;
    }
  }
}

export async function ensureFunnel(
  port: number,
  exec: typeof runExec = runExec,
  runtime: RuntimeEnv = defaultRuntime,
  prompt: typeof promptYesNo = promptYesNo,
  opts: TailscaleClientOptions = {},
) {
  // Ensure Funnel is enabled and publish the webhook port.
  try {
    const client = await resolveTailscaleClient(exec, opts);
    const statusOut = (
      await exec(client.binary, tailscaleClientArgs(client, ["funnel", "status", "--json"]))
    ).stdout.trim();
    const parsed = statusOut ? (JSON.parse(statusOut) as Record<string, unknown>) : {};
    if (!parsed || Object.keys(parsed).length === 0) {
      runtime.error(danger("Tailscale Funnel is not enabled on this tailnet/device."));
      runtime.error(
        info(
          "Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)",
        ),
      );
      runtime.error(
        info(
          "macOS user-space tailscaled docs: https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS",
        ),
      );
      const proceed = await prompt("Attempt local setup with user-space tailscaled?", true);
      if (!proceed) {
        runtime.exit(1);
      }
      await ensureBinary("brew", exec, runtime);
      await ensureGoInstalled(exec, prompt, runtime);
      await ensureTailscaledInstalled(exec, prompt, runtime);
    }

    logVerbose(`Enabling funnel on port ${port}…`);
    // Attempt with fallback
    const { stdout } = await execWithSudoFallback(
      exec,
      client.binary,
      tailscaleClientArgs(client, ["funnel", "--yes", "--bg", `${port}`]),
      {
        maxBuffer: 200_000,
        timeoutMs: 15_000,
      },
    );
    if (stdout.trim()) {
      console.log(stdout.trim());
    }
  } catch (err) {
    const errOutput = err as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof errOutput.stdout === "string" ? errOutput.stdout : "";
    const stderr = typeof errOutput.stderr === "string" ? errOutput.stderr : "";
    if (stdout.includes("Funnel is not enabled")) {
      console.error(danger("Funnel is not enabled on this tailnet/device."));
      const linkMatch = stdout.match(/https?:\/\/\S+/);
      if (linkMatch) {
        console.error(info(`Enable it here: ${linkMatch[0]}`));
      } else {
        console.error(
          info(
            "Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)",
          ),
        );
      }
    }
    if (stderr.includes("client version") || stdout.includes("client version")) {
      console.error(
        warn(
          "Tailscale client/server version mismatch detected; try updating tailscale/tailscaled.",
        ),
      );
    }
    runtime.error("Failed to enable Tailscale Funnel. Is it allowed on your tailnet?");
    runtime.error(
      info(
        `Tip: Funnel is optional for OpenClaw. You can keep running the web gateway without it: \`${formatCliCommand("openclaw gateway")}\``,
      ),
    );
    if (shouldLogVerbose()) {
      const rich = isRich();
      if (stdout.trim()) {
        runtime.error(colorize(rich, theme.muted, `stdout: ${stdout.trim()}`));
      }
      if (stderr.trim()) {
        runtime.error(colorize(rich, theme.muted, `stderr: ${stderr.trim()}`));
      }
      runtime.error(err as Error);
    }
    runtime.exit(1);
  }
}

export async function enableTailscaleServe(
  port: number,
  exec: typeof runExec = runExec,
  opts: TailscaleClientOptions = {},
) {
  const client = await resolveTailscaleClient(exec, opts);
  await execWithSudoFallback(
    exec,
    client.binary,
    tailscaleClientArgs(client, [
      "serve",
      "--bg",
      "--yes",
      "--https=443",
      `http://127.0.0.1:${port}`,
    ]),
    {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    },
  );
}

export async function hasTailscaleFunnelRouteForPort(
  port: number,
  exec: typeof runExec = runExec,
  opts: TailscaleClientOptions = {},
): Promise<boolean> {
  try {
    const client = await resolveTailscaleClient(exec, opts);
    const { stdout } = await exec(
      client.binary,
      tailscaleClientArgs(client, ["funnel", "status", "--json"]),
      {
        maxBuffer: 200_000,
        timeoutMs: 5_000,
      },
    );
    const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
    return tailscaleFunnelStatusCoversPort(parsed, port);
  } catch {
    return false;
  }
}

export async function hasTailscaleServeRouteForPort(
  port: number,
  exec: typeof runExec = runExec,
  opts: TailscaleClientOptions = {},
): Promise<boolean> {
  try {
    const client = await resolveTailscaleClient(exec, opts);
    const { stdout } = await exec(
      client.binary,
      tailscaleClientArgs(client, ["serve", "status", "--json"]),
      {
        maxBuffer: 200_000,
        timeoutMs: 5_000,
      },
    );
    const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
    return tailscaleServeStatusCoversPort(parsed, port);
  } catch {
    return false;
  }
}

export type TailscaleServeRouteVerification = {
  ok: boolean;
  host?: string;
  routeKey?: string;
  path?: string;
  proxy?: string;
  reason?: string;
};

function normalizeTailscaleServeHost(value: string): string {
  const trimmed = value.trim().replace(/\.$/, "");
  if (trimmed.endsWith(":443")) {
    return trimmed.slice(0, -4).replace(/\.$/, "");
  }
  return trimmed;
}

function readTailscaleServeHandlers(
  status: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const web = (status as { Web?: Record<string, unknown> }).Web;
  if (!web || typeof web !== "object") {
    return {};
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [routeKey, value] of Object.entries(web)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const handlers = (value as { Handlers?: Record<string, unknown> }).Handlers;
    if (handlers && typeof handlers === "object") {
      out[routeKey] = handlers;
    }
  }
  return out;
}

export function verifyTailscaleServeRoute(
  status: Record<string, unknown>,
  expected: { host: string; port: number; path?: string },
): TailscaleServeRouteVerification {
  const host = normalizeTailscaleServeHost(expected.host);
  const path = expected.path ?? "/";
  const handlersByRoute = readTailscaleServeHandlers(status);
  if (Object.keys(handlersByRoute).length === 0) {
    return { ok: false, host, path, reason: "serve status has no Web handlers" };
  }

  const routeKey = Object.keys(handlersByRoute).find((key) => {
    const routeHost = normalizeTailscaleServeHost(key);
    return routeHost === host || key === `${host}:443`;
  });
  if (!routeKey) {
    return {
      ok: false,
      host,
      path,
      reason: `serve status has no HTTPS 443 route for ${host}`,
    };
  }

  const routeHandlers = handlersByRoute[routeKey] ?? {};
  const handler = routeHandlers[path];
  if (!handler || typeof handler !== "object") {
    return {
      ok: false,
      host,
      routeKey,
      path,
      reason: `serve route ${routeKey} has no handler for ${path}`,
    };
  }
  const proxy = (handler as { Proxy?: unknown }).Proxy;
  if (typeof proxy !== "string" || proxy.length === 0) {
    return {
      ok: false,
      host,
      routeKey,
      path,
      reason: `serve route ${routeKey}${path} has no proxy backend`,
    };
  }
  if (!tailscaleProxyMatchesLoopbackPort(proxy, expected.port)) {
    return {
      ok: false,
      host,
      routeKey,
      path,
      proxy,
      reason: `serve route ${routeKey}${path} points at ${proxy}, expected http://127.0.0.1:${expected.port}`,
    };
  }
  return { ok: true, host, routeKey, path, proxy };
}

export async function verifyTailscaleServeRouteForPort(
  port: number,
  exec: typeof runExec = runExec,
  opts: TailscaleClientOptions = {},
): Promise<TailscaleServeRouteVerification> {
  const client = await resolveTailscaleClient(exec, opts);
  const host = client.dnsName ?? client.ips[0];
  if (!host) {
    return { ok: false, reason: "selected Tailscale client has no DNS name or IP" };
  }
  const { stdout } = await exec(
    client.binary,
    tailscaleClientArgs(client, ["serve", "status", "--json"]),
    {
      maxBuffer: 200_000,
      timeoutMs: 5_000,
    },
  );
  const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
  return verifyTailscaleServeRoute(parsed, { host, port, path: "/" });
}

const TAILSCALE_LOOPBACK_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function tailscaleFunnelStatusCoversPort(
  status: Record<string, unknown>,
  port: number,
): boolean {
  for (const proxy of funnelStatusBackendsForPort(status)) {
    if (tailscaleProxyMatchesLoopbackPort(proxy, port)) {
      return true;
    }
  }
  return false;
}

export function tailscaleServeStatusCoversPort(
  status: Record<string, unknown>,
  port: number,
): boolean {
  for (const proxy of tailscaleWebStatusBackends(status)) {
    if (tailscaleProxyMatchesLoopbackPort(proxy, port)) {
      return true;
    }
  }
  return false;
}

function tailscaleProxyMatchesLoopbackPort(proxy: string, port: number): boolean {
  // Tailscale stores the Proxy field as a full URL string (e.g.
  // "http://127.0.0.1:18789", "http://127.0.0.1:18789/",
  // "https+insecure://localhost:18789/api"), or as the bare forms accepted
  // by `tailscale funnel/serve` ("localhost:18789", "18789"). Strip any
  // RFC 3986 scheme (ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) "://") and
  // any trailing path before host/port match — covers documented Tailscale
  // target schemes such as `http`, `https`, and `https+insecure`.
  const stripped = proxy.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, "").replace(/\/.*$/, "");
  if (stripped === String(port)) {
    return true;
  }
  const sep = stripped.lastIndexOf(":");
  if (sep < 0) {
    return false;
  }
  const host = stripped.slice(0, sep);
  const portStr = stripped.slice(sep + 1);
  if (portStr !== String(port)) {
    return false;
  }
  return TAILSCALE_LOOPBACK_PROXY_HOSTS.has(host);
}

function tailscaleWebStatusBackends(status: Record<string, unknown>): Set<string> {
  const backends = new Set<string>();
  const web = (status as { Web?: Record<string, unknown> }).Web;
  if (!web || typeof web !== "object") {
    return backends;
  }
  for (const handlers of Object.values(web)) {
    if (!handlers || typeof handlers !== "object") {
      continue;
    }
    const handlerEntries = (handlers as { Handlers?: Record<string, unknown> }).Handlers;
    if (!handlerEntries || typeof handlerEntries !== "object") {
      continue;
    }
    for (const handler of Object.values(handlerEntries)) {
      const proxy = (handler as { Proxy?: unknown })?.Proxy;
      if (typeof proxy === "string" && proxy.length > 0) {
        backends.add(proxy);
      }
    }
  }
  return backends;
}

function funnelStatusBackendsForPort(status: Record<string, unknown>): Set<string> {
  const backends = new Set<string>();
  const allowFunnel = (status as { AllowFunnel?: Record<string, unknown> }).AllowFunnel ?? {};
  const enabledHosts = new Set(
    Object.entries(allowFunnel)
      .filter(([, value]) => value === true)
      .map(([host]) => host),
  );
  if (enabledHosts.size === 0) {
    return backends;
  }
  const web = (status as { Web?: Record<string, unknown> }).Web;
  if (!web || typeof web !== "object") {
    return backends;
  }
  for (const [host, handlers] of Object.entries(web)) {
    if (!enabledHosts.has(host)) {
      continue;
    }
    if (!handlers || typeof handlers !== "object") {
      continue;
    }
    const handlerEntries = (handlers as { Handlers?: Record<string, unknown> }).Handlers;
    if (!handlerEntries || typeof handlerEntries !== "object") {
      continue;
    }
    for (const handler of Object.values(handlerEntries)) {
      const proxy = (handler as { Proxy?: unknown })?.Proxy;
      if (typeof proxy === "string" && proxy.length > 0) {
        backends.add(proxy);
      }
    }
  }
  return backends;
}

export async function disableTailscaleServe(
  exec: typeof runExec = runExec,
  opts: TailscaleClientOptions = {},
) {
  if (opts.allowUnsafeServeReset !== true) {
    throw new Error(
      "Refusing to run broad `tailscale serve reset` without explicit allowUnsafeServeReset=true. Clear the owned Serve route manually after confirming route ownership.",
    );
  }
  const client = await resolveTailscaleClient(exec, opts);
  await execWithSudoFallback(exec, client.binary, tailscaleClientArgs(client, ["serve", "reset"]), {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function enableTailscaleFunnel(
  port: number,
  exec: typeof runExec = runExec,
  opts: TailscaleClientOptions = {},
) {
  const client = await resolveTailscaleClient(exec, opts);
  await execWithSudoFallback(
    exec,
    client.binary,
    tailscaleClientArgs(client, ["funnel", "--bg", "--yes", `${port}`]),
    {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    },
  );
}

export async function disableTailscaleFunnel(
  exec: typeof runExec = runExec,
  opts: TailscaleClientOptions = {},
) {
  const client = await resolveTailscaleClient(exec, opts);
  await execWithSudoFallback(
    exec,
    client.binary,
    tailscaleClientArgs(client, ["funnel", "reset"]),
    {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    },
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseWhoisIdentity(payload: Record<string, unknown>): TailscaleWhoisIdentity | null {
  const userProfile =
    readRecord(payload.UserProfile) ?? readRecord(payload.userProfile) ?? readRecord(payload.User);
  const login =
    normalizeOptionalString(userProfile?.LoginName) ??
    normalizeOptionalString(userProfile?.Login) ??
    normalizeOptionalString(userProfile?.login) ??
    normalizeOptionalString(payload.LoginName) ??
    normalizeOptionalString(payload.login);
  if (!login) {
    return null;
  }
  const name =
    normalizeOptionalString(userProfile?.DisplayName) ??
    normalizeOptionalString(userProfile?.Name) ??
    normalizeOptionalString(userProfile?.displayName) ??
    normalizeOptionalString(payload.DisplayName) ??
    normalizeOptionalString(payload.name);
  return { login, name };
}

function readCachedWhois(ip: string, now: number): TailscaleWhoisIdentity | null | undefined {
  const cached = whoisCache.get(ip);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= now) {
    whoisCache.delete(ip);
    return undefined;
  }
  return cached.value;
}

function writeCachedWhois(ip: string, value: TailscaleWhoisIdentity | null, ttlMs: number) {
  whoisCache.set(ip, { value, expiresAt: Date.now() + ttlMs });
}

function tailscaleWhoisCacheKey(ip: string, opts?: TailscaleClientOptions): string {
  const env = opts?.env ?? process.env;
  const binary =
    normalizePathOption(opts?.binaryPath) ?? normalizePathOption(env.OPENCLAW_TAILSCALE_BIN) ?? "";
  const socket =
    normalizePathOption(opts?.socketPath) ??
    normalizePathOption(env.OPENCLAW_TAILSCALE_SOCKET) ??
    "";
  return `${binary}\0${socket}\0${ip}`;
}

export async function readTailscaleWhoisIdentity(
  ip: string,
  exec: typeof runExec = runExec,
  opts?: TailscaleClientOptions & { timeoutMs?: number; cacheTtlMs?: number; errorTtlMs?: number },
): Promise<TailscaleWhoisIdentity | null> {
  const normalized = ip.trim();
  if (!normalized) {
    return null;
  }
  const cacheKey = tailscaleWhoisCacheKey(normalized, opts);
  const now = Date.now();
  const cached = readCachedWhois(cacheKey, now);
  if (cached !== undefined) {
    return cached;
  }

  const cacheTtlMs = opts?.cacheTtlMs ?? 60_000;
  const errorTtlMs = opts?.errorTtlMs ?? 5_000;
  try {
    const client = await resolveTailscaleClient(exec, opts);
    const { stdout } = await exec(
      client.binary,
      tailscaleClientArgs(client, ["whois", "--json", normalized]),
      {
        timeoutMs: opts?.timeoutMs ?? 5_000,
        maxBuffer: 200_000,
      },
    );
    const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
    const identity = parseWhoisIdentity(parsed);
    writeCachedWhois(cacheKey, identity, cacheTtlMs);
    return identity;
  } catch {
    writeCachedWhois(cacheKey, null, errorTtlMs);
    return null;
  }
}
