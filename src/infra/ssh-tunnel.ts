// Starts and monitors SSH tunnels for remote gateway access.
import { spawn } from "node:child_process";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { createAbortError, isAbortError, racePromiseWithAbortSignal } from "./abort-signal.js";
import { sleepWithAbort } from "./backoff.js";
import { formatErrorMessage, isErrno } from "./errors.js";
import { probeTcpListener, tryListenOnPort } from "./ports-probe.js";
import { ensurePortAvailable, PortInUseError } from "./ports.js";
import { resolveSshClient } from "./ssh-client.js";
import { parseTcpPort } from "./tcp-port.js";

export type SshParsedTarget = {
  user?: string;
  host: string;
  port: number;
};

export type SshTunnel = {
  localPort: number;
  pid: number | null;
  stop: () => Promise<void>;
};

function hasControlOrWhitespace(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || /\s/.test(char)) {
      return true;
    }
  }
  return false;
}

function isSafeSshTargetUser(user: string): boolean {
  return !hasControlOrWhitespace(user) && !user.startsWith("-");
}

// Reject hosts that would corrupt the SSH HostName field or enable argument
// injection. Parsed targets are later interpolated into unquoted ssh_config
// directives and argv, so each accepted user/host must stay one SSH token.
function isSafeSshTargetHost(host: string): boolean {
  return (
    !hasControlOrWhitespace(host) &&
    !host.startsWith("-") &&
    !host.startsWith(":") &&
    !host.endsWith(":") &&
    !host.includes("@")
  );
}

export function parseSshTarget(raw: string): SshParsedTarget | null {
  const trimmed = raw.trim().replace(/^ssh\s+/, "");
  if (!trimmed) {
    return null;
  }

  const at = trimmed.indexOf("@");
  const user = at === -1 ? undefined : trimmed.slice(0, at).trim() || undefined;
  let host = at === -1 ? trimmed : trimmed.slice(at + 1).trim();
  let port: number | null = 22;
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx > 0 && colonIdx < host.length - 1) {
    port = parseTcpPort(host.slice(colonIdx + 1).trim());
    host = host.slice(0, colonIdx).trim();
  }
  if (
    !host ||
    port === null ||
    !isSafeSshTargetHost(host) ||
    (user !== undefined && !isSafeSshTargetUser(user))
  ) {
    return null;
  }
  return { user, host, port };
}

async function waitForLocalListener(
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = performance.now(); // Clock adjustments must not change the polling budget.
  while (performance.now() - startedAt < timeoutMs) {
    if ((await probeTcpListener(port, "127.0.0.1", signal)) === "busy") {
      return;
    }
    await sleepWithAbort(50, signal);
  }
  throw new Error(`ssh tunnel did not start listening on localhost:${port}`);
}

export async function startSshPortForward(opts: {
  target: string;
  identity?: string;
  localPortPreferred: number;
  remotePort: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SshTunnel> {
  const parsed = parseSshTarget(opts.target);
  if (!parsed) {
    throw new Error(`invalid SSH target: ${opts.target}`);
  }

  const sshPath = resolveSshClient();
  if (!sshPath) {
    throw new Error("trusted SSH client not found in system directories");
  }

  let localPort = opts.localPortPreferred;
  try {
    await ensurePortAvailable(localPort, "127.0.0.1");
  } catch (err) {
    if (err instanceof PortInUseError || (isErrno(err) && err.code === "EADDRINUSE")) {
      localPort = await tryListenOnPort({ port: 0, host: "127.0.0.1" });
    } else {
      throw err;
    }
  }

  const userHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host;
  const args = [
    "-N",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${opts.remotePort}`,
    "-p",
    String(parsed.port),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (opts.identity?.trim()) {
    args.push("-i", opts.identity.trim());
  }
  // Security: Use '--' to prevent userHost from being interpreted as an option
  args.push("--", userHost);

  if (opts.signal?.aborted) {
    throw createAbortError("SSH tunnel start aborted", { cause: opts.signal.reason });
  }

  const stderr: string[] = [];
  const child = spawn(sshPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderrStream = child.stderr;
  // Child events own tunnel failure. Keep the diagnostic pipe observed so a
  // stream error cannot become an uncaught exception during active use or teardown.
  stderrStream?.on("error", () => {});
  stderrStream?.setEncoding("utf8");
  stderrStream?.on("data", (chunk: string) => stderr.push(chunk));

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("close", () => resolve());
  });
  let onAbort: (() => void) | undefined;
  const detachAbort = () => {
    if (onAbort) {
      opts.signal?.removeEventListener("abort", onAbort);
      onAbort = undefined;
    }
  };
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      detachAbort();
      // Sending a signal is not exit; every caller must await the same child lifetime.
      const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
      try {
        child.kill("SIGTERM");
        await exited;
      } finally {
        clearTimeout(timer);
      }
    })());

  const readinessController = new AbortController();
  const readiness = waitForLocalListener(
    localPort,
    Math.max(250, opts.timeoutMs),
    readinessController.signal,
  );
  try {
    try {
      await racePromiseWithAbortSignal(
        Promise.race([
          readiness,
          new Promise<void>((_, reject) => {
            child.once("error", (err) => reject(err));
            child.once("exit", (code, signal) => {
              reject(new Error(`ssh exited (${code ?? "null"}${signal ? `/${signal}` : ""})`));
            });
          }),
        ]),
        opts.signal,
      );
    } finally {
      // The race owns its losing readiness work; preserve the winner's error
      // only after its socket or retry delay has stopped and joined.
      readinessController.abort();
      await readiness.catch(() => {});
    }
  } catch (err) {
    await stop();
    if (isAbortError(err)) {
      throw err;
    }
    // Pipe chunks can split diagnostic lines; normalize only after joining them.
    const lines = normalizeStringEntries(stderr.join("").split("\n"));
    const suffix = lines.length > 0 ? `\n${lines.join("\n")}` : "";
    throw new Error(`${formatErrorMessage(err)}${suffix}`, { cause: err });
  }

  if (opts.signal) {
    // Keep cancellation attached until this exact child exits. Removing it at
    // listener readiness would let a later command signal orphan the tunnel.
    onAbort = () => void stop().catch(() => {});
    opts.signal.addEventListener("abort", onAbort, { once: true });
    if (opts.signal.aborted) {
      onAbort();
      await stop();
      throw createAbortError("SSH tunnel start aborted", { cause: opts.signal.reason });
    }
  }
  void exited.then(detachAbort);

  return {
    localPort,
    pid: typeof child.pid === "number" ? child.pid : null,
    stop,
  };
}
