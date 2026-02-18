import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { runExec } from "../process/exec.js";

/**
 * Locate the cloudflared binary using multiple strategies:
 * 1. Environment override (for testing)
 * 2. PATH lookup (via `which`)
 * 3. Known install paths
 */
export async function findCloudflaredBinary(
  exec: typeof runExec = runExec,
): Promise<string | null> {
  const forced = process.env.OPENCLAW_TEST_CLOUDFLARED_BINARY?.trim();
  if (forced) {
    return forced;
  }

  const checkBinary = async (path: string): Promise<boolean> => {
    if (!path || !existsSync(path)) {
      return false;
    }
    try {
      await Promise.race([
        exec(path, ["--version"], { timeoutMs: 3000 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      return true;
    } catch {
      return false;
    }
  };

  // Strategy 1: which command
  try {
    const { stdout } = await exec("which", ["cloudflared"]);
    const fromPath = stdout.trim();
    if (fromPath && (await checkBinary(fromPath))) {
      return fromPath;
    }
  } catch {
    // which failed, continue
  }

  // Strategy 2: Known install paths
  const knownPaths = [
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    "/opt/homebrew/bin/cloudflared",
  ];
  for (const candidate of knownPaths) {
    if (await checkBinary(candidate)) {
      return candidate;
    }
  }

  return null;
}

let cachedCloudflaredBinary: string | null = null;

export async function getCloudflaredBinary(exec: typeof runExec = runExec): Promise<string> {
  const forced = process.env.OPENCLAW_TEST_CLOUDFLARED_BINARY?.trim();
  if (forced) {
    cachedCloudflaredBinary = forced;
    return forced;
  }
  if (cachedCloudflaredBinary) {
    return cachedCloudflaredBinary;
  }
  cachedCloudflaredBinary = await findCloudflaredBinary(exec);
  return cachedCloudflaredBinary ?? "cloudflared";
}

export type CloudflaredTunnel = {
  /** Connector ID parsed from cloudflared output, if available. */
  connectorId: string | null;
  pid: number | null;
  stderr: string[];
  stop: () => Promise<void>;
};

/**
 * Start a cloudflared tunnel process using a pre-configured tunnel token.
 *
 * The token encodes the tunnel UUID, account tag, and tunnel secret — cloudflared
 * connects to the Cloudflare edge and routes traffic to the local origin.
 */
export async function startCloudflaredTunnel(opts: {
  token: string;
  timeoutMs?: number;
  exec?: typeof runExec;
}): Promise<CloudflaredTunnel> {
  const exec = opts.exec ?? runExec;
  const bin = await getCloudflaredBinary(exec);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const stderr: string[] = [];

  // Pass the token via TUNNEL_TOKEN env var rather than --token CLI arg
  // to avoid leaking the secret in `ps` output.
  const args = ["tunnel", "run"];
  const child: ChildProcess = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TUNNEL_TOKEN: opts.token },
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  let connectorId: string | null = null;

  const collectOutput = (stream: NodeJS.ReadableStream | null) => {
    stream?.on("data", (chunk: string) => {
      const lines = String(chunk)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      stderr.push(...lines);

      // Parse connector ID from cloudflared output
      for (const line of lines) {
        const match = line.match(/Registered tunnel connection\s+connectorID=([a-f0-9-]+)/i);
        if (match) {
          connectorId = match[1];
        }
      }
    });
  };

  collectOutput(child.stdout);
  collectOutput(child.stderr);

  const stop = async () => {
    if (child.killed) {
      return;
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } finally {
          resolve();
        }
      }, 1500);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  // Wait for the tunnel to register at least one connection, or timeout.
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (connectorId) {
            clearInterval(check);
            resolve();
          }
        }, 100);
        // Clean up interval on process exit
        child.once("exit", () => clearInterval(check));
      }),
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error("cloudflared tunnel did not register within timeout")),
          timeoutMs,
        );
      }),
      new Promise<void>((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `cloudflared exited before tunnel registered (${code ?? "null"}${signal ? `/${signal}` : ""})`,
            ),
          );
        });
      }),
    ]);
  } catch (err) {
    await stop();
    const suffix = stderr.length > 0 ? `\n${stderr.join("\n")}` : "";
    throw new Error(`${err instanceof Error ? err.message : String(err)}${suffix}`, { cause: err });
  }

  return {
    connectorId,
    pid: typeof child.pid === "number" ? child.pid : null,
    stderr,
    stop,
  };
}
