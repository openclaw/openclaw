import { EventEmitter } from "node:events";
import { Server } from "node:https";
import type { TlsOptions } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import { startGatewayTlsRenewal } from "./server-tls-renewal.js";

const mocks = vi.hoisted(() => ({ watchFile: vi.fn(), unwatchFile: vi.fn(), load: vi.fn() }));
vi.mock("node:fs", () => ({ watchFile: mocks.watchFile, unwatchFile: mocks.unwatchFile }));
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

function createRenewal() {
  const watcher = new EventEmitter();
  mocks.watchFile.mockImplementation((_path, _options, listener) => watcher.on("all", listener));
  mocks.unwatchFile.mockImplementation((_path, listener) => watcher.off("all", listener));
  const runtime = material();
  const server = new Server(runtime.tlsOptions);
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
  return { owner, runtime, publish, watcher, onRenewed };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.load.mockReset();
  mocks.watchFile.mockReset();
  mocks.unwatchFile.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("TLS material renewal lifetime", () => {
  it("joins a pending read on close without publishing it", async () => {
    const loaded = createDeferredCore<GatewayTlsRuntime>();
    mocks.load.mockReturnValue(loaded.promise);
    const { owner, runtime, publish, onRenewed } = createRenewal();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.load).toHaveBeenCalledOnce();
    const stopping = owner.stop();
    expect(mocks.unwatchFile).toHaveBeenCalledTimes(2);
    loaded.resolve({ ...material(), fingerprintSha256: "retired" });
    await stopping;
    expect(publish).not.toHaveBeenCalled();
    expect(onRenewed).not.toHaveBeenCalled();
    expect(runtime.fingerprintSha256).toBe("same-leaf-fingerprint");
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
});
