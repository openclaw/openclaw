// Child of the provider attempt test.
// Darwin: the parent interposes connect(2) and leaves the IPv4 socket unconnected.
// Linux: this process runs in a private net namespace and drops the real SYN, so
// the socket stays in SYN_SENT until Node's attempt timer starts IPv6.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Model } from "../../llm/types.js";

const DNS_FIXTURE_URL = "openclaw-drop-dns:promises";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:dns/promises" && context.parentURL !== DNS_FIXTURE_URL) {
      return { url: DNS_FIXTURE_URL, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== DNS_FIXTURE_URL) {
      return next(url, context);
    }
    return {
      format: "module",
      shortCircuit: true,
      source: `
        import * as actual from "node:dns/promises";
        export * from "node:dns/promises";
        export function lookup(hostname, options) {
          if (hostname === "fixture.test") {
            return Promise.resolve([
              { address: "127.0.0.1", family: 4 },
              { address: "::1", family: 6 },
            ]);
          }
          return actual.lookup(hostname, options);
        }
      `,
    };
  },
});

const { attachModelProviderRequestTransport } =
  await import("../../agents/provider-request-config.js");
const { closeProviderTransportDispatcherPool } =
  await import("../../agents/provider-transport-dispatcher-pool.js");
const { buildGuardedModelFetch } = await import("../../agents/provider-transport-fetch.js");
const { attachProviderAuthAuthority } = await import("../../plugins/provider-auth-authority.js");
const { resolveUndiciAutoSelectFamilyConnectOptions } = await import("./undici-family-policy.js");

function executable(name: string): string | undefined {
  const dirs = `${process.env.PATH ?? ""}:/sbin:/usr/sbin:/bin:/usr/bin`.split(":");
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next directory.
    }
  }
  return undefined;
}

function installIpv4Drop(port: number): void {
  const iptables = executable("iptables");
  if (iptables) {
    execFileSync(iptables, [
      "-I",
      "OUTPUT",
      "-p",
      "tcp",
      "-d",
      "127.0.0.1",
      "--dport",
      String(port),
      "-j",
      "DROP",
    ]);
    return;
  }
  const nft = executable("nft");
  if (!nft) {
    throw new Error("Linux drop fixture needs iptables or nft");
  }
  execFileSync(nft, ["add", "table", "ip", "familydrop"]);
  execFileSync(nft, [
    "add",
    "chain",
    "ip",
    "familydrop",
    "output",
    "{ type filter hook output priority 0 ; policy accept ; }",
  ]);
  execFileSync(nft, [
    "add",
    "rule",
    "ip",
    "familydrop",
    "output",
    "ip",
    "daddr",
    "127.0.0.1",
    "tcp",
    "dport",
    String(port),
    "drop",
  ]);
}

function ipv4SynSent(port: number): boolean {
  const remote = `0100007F:${port.toString(16).padStart(4, "0")}`.toUpperCase();
  let text: string;
  try {
    text = fs.readFileSync("/proc/net/tcp", "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[2]?.toUpperCase() === remote && fields[3] === "02") {
      return true;
    }
  }
  return false;
}

const netnsDrop = process.env.OPENCLAW_DROP_MODE === "netns";
if (netnsDrop) {
  const ip = executable("ip");
  if (!ip) {
    throw new Error("Linux drop fixture needs iproute2");
  }
  execFileSync(ip, ["link", "set", "lo", "up"]);
}

const server = http.createServer((_request, response) => {
  response.end("ok");
});
const sockets = new Set<Socket>();
server.on("connection", (socket) => {
  sockets.add(socket);
});
await new Promise<void>((resolve) => {
  server.listen(0, "::1", () => resolve());
});
const port = (server.address() as AddressInfo).port;
process.env.OPENCLAW_DROP_PORT = String(port);
if (netnsDrop) {
  installIpv4Drop(port);
}

const baseUrl = `http://fixture.test:${port}/v1`;
const model = attachProviderAuthAuthority(
  attachModelProviderRequestTransport(
    {
      id: "family-attempt",
      name: "family-attempt",
      provider: "family-attempt-fixture",
      api: "openai-responses",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 16,
    } as Model<"openai-responses">,
    { allowPrivateNetwork: true },
  ),
  () => undefined,
);

const started = performance.now();
let synSentAt: number | undefined;
const synPoll = netnsDrop
  ? setInterval(() => {
      if (synSentAt === undefined && ipv4SynSent(port)) {
        synSentAt = performance.now();
      }
    }, 5)
  : undefined;
try {
  const response = await buildGuardedModelFetch(model)(`${baseUrl}/models`);
  const body = await response.text();
  if (body !== "ok") {
    throw new Error(`unexpected provider body: ${body}`);
  }
  if (synPoll) {
    clearInterval(synPoll);
  }
  process.stdout.write(
    `${JSON.stringify({
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
      attemptTimeoutMs:
        resolveUndiciAutoSelectFamilyConnectOptions()?.autoSelectFamilyAttemptTimeout ?? null,
      pendingMs: synSentAt === undefined ? null : Math.round(performance.now() - synSentAt),
    })}\n`,
  );
} catch (error) {
  if (synPoll) {
    clearInterval(synPoll);
  }
  const cause = error as { code?: string; cause?: { code?: string }; message?: string };
  process.stdout.write(
    `${JSON.stringify({
      failed: true,
      code: cause.code ?? cause.cause?.code ?? null,
      message: cause.message ?? "provider request failed",
      elapsedMs: Math.round(performance.now() - started),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closeProviderTransportDispatcherPool();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}
