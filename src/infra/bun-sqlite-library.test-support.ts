import { afterEach, beforeEach, vi } from "vitest";
import type { SqliteRuntimeCapabilities } from "./bun-sqlite-library.js";

export const sqliteSelectionKey = Symbol.for("openclaw.bunSqliteLibrarySelection");
export const sqliteCapabilitiesKey = "openclaw.sqliteRuntimeCapabilities";
type LibraryProbe = { version: string; extensionLoadingSupported: boolean };

const native = vi.hoisted(() => ({
  enabled: false,
  mainThread: true,
  environment: new Map<unknown, unknown>(),
  exists: vi.fn<(pathname: string) => boolean>(),
  probe: vi.fn<(pathname: string) => LibraryProbe>(),
  select: vi.fn<(pathname: string) => void>(),
  closeProbe: vi.fn<() => Promise<SqliteRuntimeCapabilities>>(),
  publish: vi.fn<(key: unknown, value: unknown) => void>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync: typeof actual.existsSync = (pathname) =>
    native.enabled ? native.exists(String(pathname)) : actual.existsSync(pathname);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (...args: Parameters<typeof actual.createRequire>) => {
    const require = actual.createRequire(...args);
    return Object.assign((specifier: string) => {
      if (specifier === "bun:ffi") {
        return {
          FFIType: { cstring: 0, i32: 1 },
          dlopen: (pathname: string) => {
            const probe = native.probe(pathname);
            return {
              symbols: {
                sqlite3_libversion: () => probe.version,
                sqlite3_compileoption_used: () => (probe.extensionLoadingSupported ? 0 : 1),
              },
              close() {},
            };
          },
        };
      }
      if (specifier === "bun:sqlite") {
        return { Database: { setCustomSQLite: (pathname: string) => native.select(pathname) } };
      }
      return require(specifier);
    }, require);
  };
  return new Proxy(actual, {
    get: (target, property, receiver) =>
      property === "createRequire" ? createRequire : Reflect.get(target, property, receiver),
  });
});

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    get isMainThread() {
      return native.enabled ? native.mainThread : actual.isMainThread;
    },
    getEnvironmentData: (key: Parameters<typeof actual.getEnvironmentData>[0]) =>
      native.enabled ? native.environment.get(key) : actual.getEnvironmentData(key),
    setEnvironmentData: (...[key, value]: Parameters<typeof actual.setEnvironmentData>) => {
      if (native.enabled) {
        native.publish(key, value);
        native.environment.set(key, value);
      } else {
        actual.setEnvironmentData(key, value);
      }
    },
  };
});
// mock-isolation: Simulated Bun admission must not execute the host's native SQLite close probe.
vi.mock("./bun-sqlite-close-probe.js", () => ({ probeSqliteNativeClose: native.closeProbe }));

// Test startup preloads this owner before file mocks; reevaluate its native imports under them.
vi.resetModules();
export const {
  captureSqliteWorkerClosePolicy,
  ensureSqliteLibrarySelected,
  getSqliteRuntimeCapabilities,
  initializeSqliteRuntimeCapabilities,
} = await import("./bun-sqlite-library.js");

function snapshotProperty(target: object, key: PropertyKey) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return () =>
    descriptor
      ? Object.defineProperty(target, key, descriptor)
      : Reflect.deleteProperty(target, key);
}
let restore: (() => unknown)[];
beforeEach(() => {
  restore = [
    snapshotProperty(globalThis, sqliteSelectionKey),
    snapshotProperty(globalThis, "__openclawStandaloneRootUrl"),
    snapshotProperty(process, "versions"),
    snapshotProperty(process, "platform"),
  ];
});
afterEach(() => {
  restore.forEach((property) => property());
  native.enabled = false;
  native.environment.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setValue(target: object, key: PropertyKey, value: unknown) {
  if (value === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, { configurable: true, value });
  }
}

export function mockBunSqliteNativeBoundary(
  options: {
    isBun?: boolean;
    platform?: string;
    isMainThread?: boolean;
    env?: NodeJS.ProcessEnv;
    exists?: (pathname: string) => boolean;
    probe?: (pathname: string) => LibraryProbe;
    select?: (pathname: string) => void;
    standaloneRootUrl?: string;
  } = {},
) {
  native.enabled = true;
  native.mainThread = options.isMainThread ?? true;
  native.environment.clear();
  native.publish.mockReset();
  native.closeProbe.mockReset();
  native.exists = vi.fn(options.exists ?? (() => true));
  native.probe = vi.fn(
    options.probe ?? (() => ({ version: "3.53.4", extensionLoadingSupported: true })),
  );
  native.select = vi.fn(options.select ?? (() => {}));
  Reflect.deleteProperty(globalThis, sqliteSelectionKey);
  setValue(globalThis, "__openclawStandaloneRootUrl", options.standaloneRootUrl);
  setValue(process, "versions", {
    ...process.versions,
    bun: (options.isBun ?? true) ? "fixture" : undefined,
  });
  setValue(process, "platform", options.platform ?? "darwin");
  for (const key of ["OPENCLAW_SQLITE_LIBRARY", "HOMEBREW_PREFIX", "OPENCLAW_DIAGNOSTICS"]) {
    vi.stubEnv(key, options.env?.[key]);
  }
  return native;
}
