import { EventEmitter } from "node:events";
import { createServer } from "node:https";
import path from "node:path";
import type { TlsOptions } from "node:tls";
import type { Root } from "@openclaw/fs-safe/root";
import type { WatchOptions, WatchSubscription } from "@openclaw/fs-safe/watch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import { startGatewayTlsRenewal } from "./server-tls-renewal.js";

const mocks = vi.hoisted(() => ({
  watch: vi.fn<(root: Root, options: WatchOptions) => WatchSubscription>(),
  lstat: vi.fn(),
  readlink: vi.fn(),
  load: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ default: { lstat: mocks.lstat, readlink: mocks.readlink } }));
vi.mock("@openclaw/fs-safe/root", () => ({
  root: async (volume: string) => ({ rootDir: volume }),
}));
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: mocks.watch }));
vi.mock("../infra/tls/gateway.js", () => ({ loadGatewayTlsServerRuntime: mocks.load }));

function material() {
  const tlsOptions: TlsOptions = {
    cert: TEST_TLS_CERT_PEM,
    key: TEST_TLS_KEY_PEM,
    minVersion: "TLSv1.3",
  };
  return {
    enabled: true,
    required: true,
    certPath: "/synthetic/cert.pem",
    keyPath: "/synthetic/key.pem",
    fingerprintSha256: "same-leaf-fingerprint",
    tlsOptions,
  } satisfies GatewayTlsRuntime;
}

function createRenewal(runtime = material()) {
  const watcher = new EventEmitter();
  const close = vi.fn(async () => {});
  const setScopes = vi.fn(async (_scopes: WatchOptions["scopes"]) => {});
  mocks.watch.mockImplementation((_root, options) => {
    const invalidate = () => options.onInvalidate({ reason: "event" });
    watcher.on("all", invalidate);
    const retire = async () => {
      watcher.off("all", invalidate);
      await close();
    };
    return {
      ready: Promise.resolve(),
      setScopes,
      reconcile: async () => {},
      health: () => ({ state: "ready", mode: "events", directories: 1 }),
      close: retire,
      [Symbol.asyncDispose]: retire,
    };
  });
  const server = createServer(runtime.tlsOptions);
  const publish = vi.spyOn(server, "setSecureContext");
  const onRenewed = vi.fn(async () => {});
  const owner = startGatewayTlsRenewal({
    runtime,
    servers: [server],
    enabled: true,
    isClosing: () => false,
    onRenewed,
    log: { info: vi.fn(), warn: vi.fn() },
  });
  if (!owner) {
    throw new Error("TLS renewal owner was not created");
  }
  return { owner, runtime, publish, watcher, onRenewed, close, setScopes };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.load.mockReset();
  mocks.watch.mockReset();
  mocks.lstat.mockReset().mockImplementation(async (entry: string) => ({
    isDirectory: () => !entry.endsWith(".pem"),
    isSymbolicLink: () => false,
  }));
  mocks.readlink.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("TLS material renewal lifetime", () => {
  it("joins a pending read on close without publishing it", async () => {
    const loaded = createDeferredCore<GatewayTlsRuntime>();
    mocks.load.mockReturnValue(loaded.promise);
    const { owner, runtime, publish, onRenewed, close } = createRenewal();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.load).toHaveBeenCalledOnce();
    const stopping = owner.stop();
    loaded.resolve({ ...material(), fingerprintSha256: "retired" });
    await stopping;
    expect(close).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(onRenewed).not.toHaveBeenCalled();
    expect(runtime.fingerprintSha256).toBe("same-leaf-fingerprint");
  });

  it("joins observation retirement and reports its failure", async () => {
    const retirement = createDeferredCore();
    const entered = createDeferredCore();
    const { owner, close } = createRenewal();
    await vi.advanceTimersByTimeAsync(0);
    close.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    let stopped = false;
    const stopping = owner.stop().finally(() => {
      stopped = true;
    });
    await entered.promise;
    expect(stopped).toBe(false);
    const rejected = expect(stopping).rejects.toThrow("Gateway TLS observation retirement failed");
    retirement.reject(new Error("native close failed"));
    await rejected;
  });

  it("ignores an older read and adopts a complete CA change with the same leaf", async () => {
    const stale = createDeferredCore<GatewayTlsRuntime>();
    const next = material();
    next.tlsOptions = { ...next.tlsOptions, ca: TEST_TLS_CERT_PEM };
    mocks.load.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(next);
    const { owner, runtime, publish, watcher, onRenewed } = createRenewal();
    const acceptedOptions = runtime.tlsOptions;
    try {
      await vi.advanceTimersByTimeAsync(300);
      watcher.emit("all", "change", "/synthetic/cert.pem");
      await vi.advanceTimersByTimeAsync(300);
      stale.resolve({ ...material(), fingerprintSha256: "stale" });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.load).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledExactlyOnceWith(next.tlsOptions);
      expect(runtime.tlsOptions).toBe(acceptedOptions);
      expect(runtime.tlsOptions?.ca).toBe(TEST_TLS_CERT_PEM);
      expect(runtime.fingerprintSha256).toBe("same-leaf-fingerprint");
      expect(onRenewed).toHaveBeenCalledOnce();
    } finally {
      await owner.stop();
    }
  });

  it("fences a read when disabled and reconciles on re-enable without another file event", async () => {
    const stale = createDeferredCore<GatewayTlsRuntime>();
    const next = material();
    next.tlsOptions = { ...next.tlsOptions, ca: TEST_TLS_CERT_PEM };
    mocks.load.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(next);
    const { owner, publish, watcher, onRenewed } = createRenewal();
    try {
      await vi.advanceTimersByTimeAsync(300);
      owner.setEnabled(false);
      stale.resolve({ ...material(), fingerprintSha256: "disabled" });
      watcher.emit("all", "change", "/synthetic/key.pem");
      await vi.advanceTimersByTimeAsync(300);
      expect(publish).not.toHaveBeenCalled();
      expect(mocks.load).toHaveBeenCalledOnce();
      owner.setEnabled(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(publish).toHaveBeenCalledExactlyOnceWith(next.tlsOptions);
      expect(onRenewed).toHaveBeenCalledOnce();
    } finally {
      await owner.stop();
    }
  });

  it("observes chained certificate links and retargets projected secrets without changing accepted paths", async () => {
    let generation = "generation-one";
    const projected = path.resolve("/synthetic/..data");
    const cert = path.resolve("/synthetic/cert.pem");
    mocks.lstat.mockImplementation(async (entry: string) => ({
      isDirectory: () => !entry.endsWith(".pem"),
      isSymbolicLink: () => entry === cert || entry === projected,
    }));
    mocks.readlink.mockImplementation(async (entry: string) =>
      entry === cert ? "..data/cert.pem" : generation,
    );
    mocks.load.mockResolvedValue(material());
    const { owner, watcher, close } = createRenewal();
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(
        mocks.watch.mock.calls.map(([authority, options]) => [authority.rootDir, options.scopes]),
      ).toEqual([
        [
          path.resolve("/synthetic"),
          [
            { path: "..data", kind: "entry" },
            { path: "cert.pem", kind: "entry" },
            { path: "key.pem", kind: "entry" },
          ],
        ],
        [path.resolve("/synthetic/generation-one"), [{ path: "cert.pem", kind: "entry" }]],
      ]);
      generation = "generation-two";
      watcher.emit("all");
      await vi.advanceTimersByTimeAsync(300);
      expect(close).toHaveBeenCalledOnce();
      expect(mocks.watch).toHaveBeenCalledTimes(3);
      expect(mocks.watch.mock.calls[2]?.[0].rootDir).toBe(
        path.resolve("/synthetic/generation-two"),
      );
      expect(mocks.watch.mock.calls[2]?.[1].scopes).toEqual([{ path: "cert.pem", kind: "entry" }]);
      expect(mocks.load).toHaveBeenLastCalledWith(
        expect.objectContaining({
          certPath: "/synthetic/cert.pem",
          keyPath: "/synthetic/key.pem",
        }),
      );
    } finally {
      await owner.stop();
    }
    expect(close).toHaveBeenCalledTimes(3);
  });
});
