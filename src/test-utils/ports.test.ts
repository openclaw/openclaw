import { createServer as createRealServer } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withEnvAsync } from "./env.js";
import { spawnNodeEvalSync } from "./node-process.js";

const host = vi.hoisted(() => ({
  platform: vi.fn(() => "linux"),
  range: "32768\t60999\n",
  reads: vi.fn((): string => host.range),
  cacheKey: Symbol("test port host"),
  rejectPort: vi.fn<(...args: [number]) => string | undefined>(() => undefined),
}));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      const listen = server.listen.bind(server);
      vi.spyOn(server, "listen").mockImplementation((...listenArgs) => {
        const port = listenArgs[0];
        const code = typeof port === "number" ? host.rejectPort(port) : undefined;
        if (code) {
          queueMicrotask(() => server.emit("error", Object.assign(new Error(code), { code })));
          return server;
        }
        return listen(...listenArgs);
      });
      return server;
    },
  };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: host.platform,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      args[0] === "/proc/sys/net/ipv4/ip_local_port_range"
        ? host.reads()
        : actual.readFileSync(...args),
  };
});
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) => {
      if (args[0] === Symbol.for("openclaw.testPortPool")) {
        args[0] = host.cacheKey;
      }
      return actual.resolveGlobalSingleton(...args);
    },
  };
});

const listeners: ReturnType<typeof createRealServer>[] = [];
let ports: typeof import("./ports.js");
const defaultOffsets = [0, 1, 2, 3, 4];
const fallbackOffsets = [0, 1, 2, 4];
const allocate = (offsets?: number[], fallback = false) =>
  fallback
    ? ports.getFreePortBlockWithPermissionFallback({
        offsets: offsets ?? defaultOffsets,
        fallbackBase: 44000,
      })
    : ports.getDeterministicFreePortBlock(offsets && { offsets });

function expectBlock(
  port: number,
  offsets: number[],
  outside?: [number, number],
  inside: [number, number] = [1024, 65535],
) {
  for (const offset of offsets) {
    const candidate = port + offset;
    expect(candidate).toBeGreaterThanOrEqual(inside[0]);
    expect(candidate).toBeLessThanOrEqual(inside[1]);
    if (outside) {
      expect(candidate < outside[0] || candidate > outside[1]).toBe(true);
    }
  }
}

async function bindPort(port: number) {
  const server = createRealServer();
  listeners.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

beforeEach(async () => {
  vi.resetModules();
  host.platform.mockReturnValue("linux");
  host.range = "32768\t60999\n";
  host.reads.mockClear();
  host.rejectPort.mockReset();
  host.cacheKey = Symbol("test port host");
  ports = await import("./ports.js");
});

afterEach(async () => {
  if (host.platform() !== "linux") {
    expect.soft(host.reads).not.toHaveBeenCalled();
  }
  Reflect.deleteProperty(globalThis, host.cacheKey);
  for (const server of listeners.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

it("excludes kernel client ports across workers", async () => {
  const [low, high] = [20000, 65000];
  host.range = `${low}\t${high}\n`;
  for (let worker = 0; worker < 64; worker += 1) {
    const port = await withEnvAsync({ VITEST_WORKER_ID: String(worker) }, () => allocate());
    expectBlock(port, defaultOffsets, [low, high]);
  }
  expect(host.reads).toHaveBeenCalledTimes(1);
});

it.each(["linux", "darwin"])("binds non-overlapping %s blocks", async (os) => {
  host.platform.mockReturnValue(os);
  const bound = new Set<number>();
  for (let block = 0; block < 2; block += 1) {
    const port = await allocate();
    if (os === "darwin") {
      expectBlock(port, defaultOffsets, undefined, [30000, 64999]);
    }
    for (const offset of defaultOffsets) {
      expect(bound.has(port + offset)).toBe(false);
      await bindPort(port + offset);
      bound.add(port + offset);
    }
  }
});

it("excludes HTTP-blocked base and derived ports", async () => {
  const first = 1712,
    last = 1719,
    offsets = [0, 7];
  host.range = "2024 65535";
  host.rejectPort.mockImplementation((port) =>
    (port >= first && port <= last) || (port >= 1800 && port <= 1807) ? undefined : "EADDRINUSE",
  );
  await expect(ports.isPortFree(last)).resolves.toBe(true);
  const blocked = spawnNodeEvalSync(
    `try { await fetch("http://127.0.0.1:${last}/"); process.exitCode = 1; } catch (error) { process.stdout.write(JSON.stringify({ cause: error.cause?.message })); }`,
  );
  expect(blocked.error, blocked.stderr).toBeUndefined();
  expect(blocked.status, blocked.stderr).toBe(0);
  expect(JSON.parse(blocked.stdout)).toEqual({ cause: "bad port" });
  const port = await allocate(offsets);
  expectBlock(port, offsets, undefined, [1800, 1807]);
});

it.each([
  [0, false],
  [1, true],
] as const)("retries Windows EACCES +%i (fallback=%s)", async (deniedOffset, fallback) => {
  host.platform.mockReturnValue("win32");
  let firstCandidate: number | undefined;
  host.rejectPort.mockImplementation((port) => {
    firstCandidate ??= port;
    return port === firstCandidate + deniedOffset ? "EACCES" : undefined;
  });
  const offsets = [0, 1];
  const port = await allocate(offsets, fallback);
  expect(firstCandidate).toBeDefined();
  expect(port).not.toBe(firstCandidate);
  for (const offset of offsets) {
    const candidate = port + offset;
    expect(candidate).not.toBe(firstCandidate! + deniedOffset);
    expect(host.rejectPort).toHaveBeenCalledWith(candidate);
    await bindPort(candidate);
  }
});

it.each([
  ["linux", "EACCES", false],
  ["win32", "EPERM", false],
  ["win32", "EACCES", false],
  ["win32", "EACCES", true],
] as const)("rejects %s %s (ephemeralOnly=%s)", async (os, code, ephemeralOnly) => {
  host.platform.mockReturnValue(os);
  host.rejectPort.mockImplementation((port) => (ephemeralOnly && port === 0 ? undefined : code));
  const result = allocate([0, 1]);
  if (ephemeralOnly) {
    await expect(result).rejects.toThrow("failed to acquire a free port block");
    expect(host.rejectPort).toHaveBeenCalledWith(0);
  } else {
    await expect(result).rejects.toMatchObject({ code });
  }
});

it("falls back outside occupied worker and kernel ranges", async () => {
  let occupiedStart: number | undefined;
  host.rejectPort.mockImplementation((port) => {
    occupiedStart ??= port;
    return port === 0 || (port >= occupiedStart && port < occupiedStart + 1000)
      ? "EADDRINUSE"
      : undefined;
  });
  const port = await allocate();
  expect(occupiedStart).toBeDefined();
  expectBlock(port, defaultOffsets, [occupiedStart!, occupiedStart! + 999]);
  expectBlock(port, defaultOffsets, [32768, 60999]);
  for (const offset of defaultOffsets) {
    expect(host.rejectPort).toHaveBeenCalledWith(port + offset);
  }
  expect(host.rejectPort).not.toHaveBeenCalledWith(0);
});

it.each([
  ["linux", "EPERM"],
  ["linux", "EACCES"],
  ["darwin", "EACCES"],
  ["win32", "EACCES"],
])("preserves safe %s fallback on %s", async (os, code) => {
  host.platform.mockReturnValue(os);
  host.rejectPort.mockReturnValue(code);
  const port = await allocate(fallbackOffsets, true);
  if (os !== "linux") {
    expect(port).toBe(44000 + (process.pid % 10000));
    return;
  }
  expectBlock(port, fallbackOffsets, [32768, 60999]);
  expect(host.rejectPort.mock.calls.map(([candidate]) => candidate)).toEqual(
    fallbackOffsets.map((offset) => port + offset),
  );
});

it("skips HTTP-blocked ports before Linux permission fallback", async () => {
  host.range = "1 1711";
  host.rejectPort.mockReturnValue("EPERM");
  // Select the first safe shard so +7 first hits Fetch-blocked port 1719.
  await withEnvAsync({ VITEST_WORKER_ID: String(64 - (process.pid % 64)) }, async () => {
    const port = await allocate([0, 7], true);
    expect(port).toBe(1728);
    expect(host.rejectPort.mock.calls.map(([candidate]) => candidate)).toEqual([1728, 1735]);
  });
});

it.each([
  ["1024 65535", false, /ephemeral TCP (port )?range/],
  ["invalid", false, /ephemeral TCP (port )?range/],
  ["denied", true, "failed to read Linux ephemeral TCP port range"],
] as const)("rejects Linux range %s before probing", async (range, denied, error) => {
  host.range = range;
  if (denied) {
    host.reads.mockImplementationOnce(() => {
      throw Object.assign(new Error("proc access denied"), { code: "EACCES" });
    });
  }
  await expect(allocate(denied ? fallbackOffsets : undefined, denied)).rejects.toThrow(error);
  expect(host.rejectPort).not.toHaveBeenCalled();
});
