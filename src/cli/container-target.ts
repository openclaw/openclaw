import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { rewriteUpdateFlagArgv } from "./argv.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";
import { resolveSubprocessExitCode } from "./subprocess-exit-code.js";

type CliContainerParseResult =
  | { ok: true; container: string | null; argv: string[] }
  | { ok: false; error: string };

type CliContainerTargetResult =
  | { handled: true; exitCode: number }
  | { handled: false; argv: string[] };

const CONTAINER_RUNTIMES = ["podman", "docker"] as const;
type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number];

const CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV = "OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL";
const CONTAINER_RUNTIME_PROBE_TIMEOUT_MS = 10_000;

export function parseCliContainerArgs(argv: string[]): CliContainerParseResult {
  let container: string | null = null;

  const scanned = scanCliRootOptions(argv, ({ arg, args, index }) => {
    if (arg === "--container" || arg.startsWith("--container=")) {
      const next = args[index + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (!value) {
        return { kind: "error", error: "--container requires a value" };
      }
      container = value;
      return { kind: "handled", consumedNext };
    }
    return { kind: "pass" };
  });

  if (!scanned.ok) {
    return scanned;
  }

  return { ok: true, container, argv: scanned.argv };
}

export function resolveCliContainerTarget(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const parsed = parseCliContainerArgs(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.container ?? normalizeOptionalString(env.OPENCLAW_CONTAINER) ?? null;
}

function resolveRunningContainer(containerName: string): ContainerRuntime | null {
  const matches = CONTAINER_RUNTIMES.filter((runtime) => {
    const result = spawnSync(
      runtime,
      ["inspect", "--format", "{{.State.Running}}", containerName],
      { encoding: "utf8", killSignal: "SIGKILL", timeout: CONTAINER_RUNTIME_PROBE_TIMEOUT_MS },
    );
    return result.status === 0 && result.stdout.trim() === "true";
  });
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const runtimes = matches.join(", ");
    throw new Error(
      `Container "${containerName}" is running under multiple runtimes (${runtimes}); use a unique container name.`,
    );
  }
  return expectDefined(matches[0], "matches capture group 0");
}

function buildContainerExecArgs(
  runtime: ContainerRuntime,
  containerName: string,
  argv: string[],
): string[] {
  // Preserve proxy env only after loopback validation; localhost would point inside the container.
  const envFlag = runtime === "docker" ? "-e" : "--env";
  const proxyUrl = normalizeOptionalString(process.env.OPENCLAW_PROXY_URL);
  if (proxyUrl) {
    assertContainerProxyUrlIsReachable(proxyUrl);
  }
  const proxyEnvArgs = proxyUrl ? [envFlag, `OPENCLAW_PROXY_URL=${proxyUrl}`] : [];
  return [
    "exec",
    "-i",
    ...(process.stdin.isTTY && process.stdout.isTTY ? ["-t"] : []),
    envFlag,
    `OPENCLAW_CONTAINER_HINT=${containerName}`,
    envFlag,
    "OPENCLAW_CLI_CONTAINER_BYPASS=1",
    ...proxyEnvArgs,
    containerName,
    "openclaw",
    ...argv,
  ];
}

function assertContainerProxyUrlIsReachable(proxyUrl: string): void {
  if (process.env[CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV] === "1") {
    return;
  }
  const parsed = URL.parse(proxyUrl);
  if (!parsed || !isLoopbackProxyHostname(parsed.hostname)) {
    return;
  }
  throw new Error(
    `OPENCLAW_PROXY_URL=${redactProxyUrlForMessage(proxyUrl)} is loopback; 127.0.0.1 inside a container points at the container, not the host. ` +
      `Use a container-reachable proxy address, or set ${CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV}=1 if this is intentional.`,
  );
}

function isLoopbackProxyHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.+$/, "");
  if (normalizedHostname === "localhost") {
    return true;
  }
  if (isIP(normalizedHostname) === 4) {
    return normalizedHostname.startsWith("127.");
  }
  const ipv6Hostname = normalizedHostname.replace(/^\[|\]$/g, "");
  if (isIP(ipv6Hostname) !== 6) {
    return false;
  }
  if (ipv6Hostname === "::1" || ipv6Hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6Hostname);
  if (!mapped) {
    return false;
  }
  const high = Number.parseInt(expectDefined(mapped[1], "mapped capture group 1"), 16);
  return Number.isInteger(high) && high >= 0x7f00 && high <= 0x7fff;
}

function redactProxyUrlForMessage(raw: string): string {
  const url = URL.parse(raw);
  if (!url) {
    return "<invalid URL>";
  }
  if (url.username || url.password) {
    url.username = "redacted";
    url.password = url.password ? "redacted" : "";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildContainerExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  // Container-targeted CLI invocations should use the container's own profile
  // and gateway auth/runtime state rather than inheriting host overrides.
  delete next.OPENCLAW_PROFILE;
  delete next.OPENCLAW_GATEWAY_PORT;
  delete next.OPENCLAW_GATEWAY_URL;
  delete next.OPENCLAW_GATEWAY_TOKEN;
  delete next.OPENCLAW_GATEWAY_PASSWORD;
  // The child CLI should render container-aware follow-up commands via
  // OPENCLAW_CONTAINER_HINT, but it should not treat itself as still
  // container-targeted for validation/routing.
  next.OPENCLAW_CONTAINER = "";
  return next;
}

function isBlockedContainerCommand(argv: string[]): boolean {
  const invocationArgv = ["node", "openclaw", ...argv];
  return (
    resolveCliArgvInvocation(invocationArgv).primary === "update" ||
    // A shorthand is blocked even when malformed root options hide the rewritten primary.
    rewriteUpdateFlagArgv(invocationArgv) !== invocationArgv
  );
}

export function maybeRunCliInContainer(argv: string[]): CliContainerTargetResult {
  if (process.env.OPENCLAW_CLI_CONTAINER_BYPASS === "1") {
    return { handled: false, argv };
  }

  const parsed = parseCliContainerArgs(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const containerName = parsed.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER);
  if (!containerName) {
    return { handled: false, argv: parsed.argv };
  }
  if (isBlockedContainerCommand(parsed.argv.slice(2))) {
    throw new Error(
      "openclaw update is not supported with --container; rebuild or restart the container image instead.",
    );
  }

  const runningContainer = resolveRunningContainer(containerName);
  if (!runningContainer) {
    throw new Error(`No running container matched "${containerName}" under podman or docker.`);
  }

  const result = spawnSync(
    runningContainer,
    buildContainerExecArgs(runningContainer, containerName, parsed.argv.slice(2)),
    {
      stdio: "inherit",
      env: buildContainerExecEnv(process.env),
    },
  );
  if (result.error) {
    throw result.error;
  }
  return {
    handled: true,
    exitCode: resolveSubprocessExitCode(result.status, result.signal),
  };
}
