// Gateway provider requests use the shared family budget. The stall is scheduled
// from the request's pre-connect authority so it overlaps Node's attempt timer
// the way a loaded event loop does. A fake timer cannot reproduce that race.
import { execFileSync, spawnSync } from "node:child_process";
import type { LookupAddress } from "node:dns";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { attachModelProviderRequestTransport } from "../../agents/provider-request-config.js";
import { closeProviderTransportDispatcherPool } from "../../agents/provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "../../agents/provider-transport-fetch.js";
import type { Model } from "../../llm/types.js";
import { attachProviderAuthAuthority } from "../../plugins/provider-auth-authority.js";
import { isWSL2Sync } from "../wsl.js";
import { resolveUndiciAutoSelectFamilyConnectOptions } from "./undici-family-policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dropFixtureSupported = process.platform === "darwin" || process.platform === "linux";

// Drops one IPv4 destination port inside the child process. Returning
// EINPROGRESS without calling the kernel leaves the handshake unanswered, so
// Node's attempt timer — not the host route — decides when IPv6 starts.
const DROP_CONNECT_C = `#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <stdlib.h>
#ifdef __APPLE__
#include <netinet/in.h>
#include <sys/socket.h>
static int drop_connect(int fd, const struct sockaddr *addr, socklen_t len) {
  if (addr && addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    const char *port_env = getenv("OPENCLAW_DROP_PORT");
    unsigned port = port_env ? (unsigned)strtoul(port_env, 0, 10) : 0;
    if (ntohl(in->sin_addr.s_addr) == 0x7F000001u && port && ntohs(in->sin_port) == port) {
      errno = EINPROGRESS;
      return -1;
    }
  }
  return connect(fd, addr, len);
}
#define DYLD_INTERPOSE(_repl, _orig) \\
  __attribute__((used)) static struct { const void *repl; const void *orig; } \\
  _interpose_##_orig __attribute__((section("__DATA,__interpose"))) = { &_repl, &_orig };
DYLD_INTERPOSE(drop_connect, connect)
#else
#include <dlfcn.h>
#include <netinet/in.h>
#include <sys/socket.h>
int connect(int fd, const struct sockaddr *addr, socklen_t len) {
  static int (*real_connect)(int, const struct sockaddr *, socklen_t);
  if (!real_connect) {
    real_connect = (int (*)(int, const struct sockaddr *, socklen_t))dlsym(RTLD_NEXT, "connect");
  }
  if (addr && addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    const char *port_env = getenv("OPENCLAW_DROP_PORT");
    unsigned port = port_env ? (unsigned)strtoul(port_env, 0, 10) : 0;
    if (ntohl(in->sin_addr.s_addr) == 0x7F000001u && port && ntohs(in->sin_port) == port) {
      errno = EINPROGRESS;
      return -1;
    }
  }
  return real_connect(fd, addr, len);
}
#endif
`;

const HOSTNAME = "fixture.test";
const STALL_MS = 700;

const dnsFixture = vi.hoisted(() => ({
  answers: [] as LookupAddress[],
}));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup(hostname: string, options?: unknown) {
      if (hostname === HOSTNAME) {
        return Promise.resolve(dnsFixture.answers);
      }
      return actual.lookup(hostname, options as never);
    },
  };
});

function blockEventLoop(durationMs: number): void {
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    // The handshake can finish in the kernel while this thread cannot observe it.
  }
}

function scheduleConnectStall(durationMs: number): void {
  process.nextTick(() => {
    process.nextTick(() => blockEventLoop(durationMs));
  });
}

async function withListener(
  host: "127.0.0.1" | "::1",
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.end("ok");
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  }
}

async function providerStatus(
  port: number,
  stallMs: number,
): Promise<{
  status: number;
  elapsedMs: number;
}> {
  let authorityCalls = 0;
  const baseUrl = `http://${HOSTNAME}:${port}/v1`;
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
    () => {
      authorityCalls += 1;
      // The first call is before DNS. The pre-connect call overlaps the attempt timer.
      if (authorityCalls === 2 && stallMs > 0) {
        scheduleConnectStall(stallMs);
      }
    },
  );
  const started = performance.now();
  const response = await buildGuardedModelFetch(model)(`${baseUrl}/models`);
  const body = await response.text();
  if (body !== "ok") {
    throw new Error(`unexpected provider body: ${body}`);
  }
  return { status: response.status, elapsedMs: Math.round(performance.now() - started) };
}

afterEach(async () => {
  dnsFixture.answers = [];
  await closeProviderTransportDispatcherPool();
  vi.unstubAllEnvs();
});

function pinProviderDns(addresses: LookupAddress[]): void {
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  vi.stubEnv("http_proxy", "");
  vi.stubEnv("https_proxy", "");
  dnsFixture.answers = addresses;
}

it.skipIf(isWSL2Sync())(
  "keeps a Gateway provider request when the event loop stalls for 700 ms",
  async () => {
    pinProviderDns([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await withListener("127.0.0.1", async (port) => {
      const result = await providerStatus(port, STALL_MS);
      expect(result.status).toBe(200);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(STALL_MS);
      expect(result.elapsedMs).toBeLessThan(3_000);
    });
  },
);

it.skipIf(isWSL2Sync())("reaches IPv6 when the IPv4 address refuses the connection", async () => {
  pinProviderDns([
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
  await withListener("::1", async (port) => {
    const result = await providerStatus(port, 0);
    const attemptTimeoutMs =
      resolveUndiciAutoSelectFamilyConnectOptions()?.autoSelectFamilyAttemptTimeout ?? 1_000;
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBeLessThan(attemptTimeoutMs);
  });
});

it.skipIf(isWSL2Sync() || !dropFixtureSupported)(
  "reaches IPv6 after the attempt budget when the IPv4 handshake is dropped",
  () => {
    const root = tempDirs.make("family-drop-");
    const source = path.join(root, "drop-connect.c");
    const library = path.join(
      root,
      process.platform === "darwin" ? "drop-connect.dylib" : "drop-connect.so",
    );
    fs.writeFileSync(source, DROP_CONNECT_C);
    execFileSync(
      "cc",
      process.platform === "darwin"
        ? ["-dynamiclib", "-O2", source, "-o", library]
        : ["-shared", "-fPIC", "-O2", source, "-o", library, "-ldl"],
    );
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./undici-family-policy.provider-drop-fixture.mts", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          [process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"]: library,
          OPENCLAW_DEBUG_PROXY_ENABLED: "0",
          OPENCLAW_PROXY_ACTIVE: "0",
          http_proxy: "",
          https_proxy: "",
        },
      },
    );
    const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    if (child.status !== 0) {
      throw new Error(output);
    }
    const result = JSON.parse(child.stdout.trim()) as {
      status: number;
      elapsedMs: number;
      attemptTimeoutMs: number;
    };
    expect(result.attemptTimeoutMs).toBe(1_000);
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(result.attemptTimeoutMs - 100);
    expect(result.elapsedMs).toBeLessThan(8_000);
  },
);
