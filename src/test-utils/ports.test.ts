import { once } from "node:events";
import { createServer as createRealServer } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withEnvAsync } from "./env.js";

const host = vi.hoisted(() => ({
  platform: vi.fn(() => "linux"),
  range: "32768\t60999\n",
  reads: vi.fn((): string => host.range),
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
const poolKey = Symbol.for("openclaw.testPortPool");
let savedPool: PropertyDescriptor | undefined;

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

type Bounds = [number, number];
function expectBlock(port: number, offsets: number[], outside?: Bounds, inside?: Bounds) {
  const [low, high] = inside ?? [1024, 65535];
  for (const offset of offsets) {
    const candidate = port + offset;
    expect(candidate).toBeGreaterThanOrEqual(low);
    expect(candidate).toBeLessThanOrEqual(high);
    if (outside) {
      expect(candidate < outside[0] || candidate > outside[1]).toBe(true);
    }
  }
}

async function bindPort(port: number) {
  const server = createRealServer();
  listeners.push(server);
  await once(server.listen(port, "127.0.0.1"), "listening");
}

beforeEach(async () => {
  vi.resetModules();
  host.platform.mockReturnValue("linux");
  host.range = "32768\t60999\n";
  host.rejectPort.mockReset();
  savedPool = Object.getOwnPropertyDescriptor(globalThis, poolKey);
  Reflect.deleteProperty(globalThis, poolKey);
  ports = await import("./ports.js");
});

afterEach(async () => {
  Reflect.deleteProperty(globalThis, poolKey);
  if (savedPool) {
    Object.defineProperty(globalThis, poolKey, savedPool);
  }
  for (const server of listeners.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

it.each([
  ["linux", -1, false],
  ["darwin", -1, false],
  ["win32", 0, false],
  ["win32", 1, true],
] as const)("binds %s (deny=%s, fallback=%s)", async (os, denial, fallback) => {
  host.platform.mockReturnValue(os);
  host.range = "20000 65000";
  let first: number | undefined;
  host.rejectPort.mockImplementation((port) => {
    first ??= port;
    return denial >= 0 && port === first + denial ? "EACCES" : undefined;
  });
  for (let worker = 0; worker < (os === "linux" ? 64 : 2); worker++) {
    const port = await withEnvAsync({ VITEST_WORKER_ID: String(worker) }, () =>
      allocate(defaultOffsets, fallback),
    );
    expectBlock(
      port,
      defaultOffsets,
      os === "linux" ? [20000, 65000] : undefined,
      os === "linux" ? [1024, 65535] : [30000, 64999],
    );
    if (worker < 2) {
      for (const offset of defaultOffsets) {
        await bindPort(port + offset);
      }
    }
  }
});

it("excludes HTTP-blocked base and derived ports", async () => {
  const offsets = [0, 7];
  host.range = "2024 65535";
  host.rejectPort.mockImplementation((port) =>
    (port >= 1712 && port <= 1719) || (port >= 1800 && port <= 1807) ? undefined : "EADDRINUSE",
  );
  expectBlock(await allocate(offsets), offsets, undefined, [1800, 1807]);
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
});

it.each([
  ["linux", "EACCES", false, false],
  ["win32", "EPERM", false, false],
  ["win32", "EACCES", false, false],
  ["win32", "EACCES", false, true],
  ["linux", "EPERM", true, false],
  ["linux", "EACCES", true, false],
  ["darwin", "EACCES", true, false],
  ["win32", "EACCES", true, false],
] as const)("%s %s: fallback=%s, ephemeral=%s", async (os, code, fallback, ephemeral) => {
  host.platform.mockReturnValue(os);
  host.rejectPort.mockImplementation((port) => (ephemeral && port === 0 ? undefined : code));
  const result = allocate(fallback ? fallbackOffsets : [0, 1], fallback);
  if (fallback) {
    const port = await result;
    if (os === "linux") {
      expectBlock(port, fallbackOffsets, [32768, 60999]);
    } else {
      expect(port).toBe(44000 + (process.pid % 10000));
    }
  } else if (ephemeral) {
    await expect(result).rejects.toThrow("failed to acquire a free port block");
    expect(host.rejectPort).toHaveBeenCalledWith(0);
  } else {
    await expect(result).rejects.toMatchObject({ code });
  }
});

it("skips HTTP-blocked ports before Linux permission fallback", async () => {
  host.range = "1 1711";
  host.rejectPort.mockReturnValue("EPERM");
  // Select the first safe shard so +7 first hits Fetch-blocked port 1719.
  await withEnvAsync({ VITEST_WORKER_ID: String(64 - (process.pid % 64)) }, async () => {
    const port = await allocate([0, 7], true);
    expect(port).toBe(1728);
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
