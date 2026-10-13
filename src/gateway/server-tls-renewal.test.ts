import { EventEmitter } from "node:events";
import { createServer } from "node:https";
import type { TlsOptions } from "node:tls";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startGatewayTlsRenewal } from "./server-tls-renewal.js";

const mocks = vi.hoisted(() => ({ watchFile: vi.fn(), unwatchFile: vi.fn(), load: vi.fn() }));
vi.mock("node:fs", () => ({ watchFile: mocks.watchFile, unwatchFile: mocks.unwatchFile }));
vi.mock("../infra/tls/gateway.js", () => ({ loadGatewayTlsServerRuntime: mocks.load }));

function material(ca?: TlsOptions["ca"]) {
  const tlsOptions: TlsOptions = {
    cert: TEST_TLS_CERT_PEM,
    key: TEST_TLS_KEY_PEM,
    minVersion: "TLSv1.3",
    ...(ca ? { ca } : {}),
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
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const watcher = new EventEmitter();
  mocks.watchFile.mockImplementation((_path, _options, listener) => watcher.on("all", listener));
  mocks.unwatchFile.mockImplementation((_path, listener) => watcher.off("all", listener));
  const runtime = material();
  const server = createServer(runtime.tlsOptions);
  const publish = vi.spyOn(server, "setSecureContext");
  const onRenewed = vi.fn(async () => {});
  const owner = startGatewayTlsRenewal({
    scheduler,
    runtime,
    servers: [server],
    enabled: true,
    onRenewed,
    log: { info: vi.fn(), warn: vi.fn() },
  });
  if (!owner) {
    throw new Error("TLS renewal owner was not created");
  }
  return { owner, runtime, publish, watcher, onRenewed, clock, scheduler };
}

function deferNextRead() {
  const started = createDeferredCore();
  const loaded = createDeferredCore<GatewayTlsRuntime>();
  mocks.load.mockImplementationOnce(() => {
    started.resolve();
    return loaded.promise;
  });
  return { started, loaded };
}

beforeEach(() => {
  mocks.load.mockReset();
  mocks.watchFile.mockReset();
  mocks.unwatchFile.mockReset();
});

describe("TLS material renewal lifetime", () => {
  it.each(["renewal", "scheduler"] as const)(
    "joins a pending read on %s close without publishing it",
    async (closingOwner) => {
      const { started, loaded } = deferNextRead();
      const { owner, runtime, publish, watcher, onRenewed, clock, scheduler } = createRenewal();
      const wake = clock.advanceBy(300);
      try {
        await started.promise;
        expect(mocks.load).toHaveBeenCalledOnce();
        let stopped = false;
        const stopping = (closingOwner === "renewal" ? owner.stop() : scheduler.stop()).then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        loaded.resolve({ ...material(TEST_TLS_CERT_PEM), fingerprintSha256: "retired" });
        await Promise.all([wake, stopping]);
        expect(stopped).toBe(true);
        expect(publish).not.toHaveBeenCalled();
        expect(onRenewed).not.toHaveBeenCalled();
        expect(runtime.fingerprintSha256).toBe("same-leaf-fingerprint");
      } finally {
        loaded.resolve(material());
        await Promise.all([wake, owner.stop(), scheduler.stop()]);
      }
      expect(watcher.listenerCount("all")).toBe(0);
    },
  );

  it("debounces file changes, ignores an older read, and adopts a CA change with the same leaf", async () => {
    const { started, loaded } = deferNextRead();
    const next = material(TEST_TLS_CERT_PEM);
    mocks.load.mockResolvedValueOnce(next);
    const { owner, runtime, publish, watcher, onRenewed, clock, scheduler } = createRenewal();
    const acceptedOptions = runtime.tlsOptions;
    const firstWake = clock.advanceBy(300);
    try {
      await started.promise;
      watcher.emit("all", "change", "/synthetic/cert.pem");
      await clock.advanceBy(200);
      watcher.emit("all", "change", "/synthetic/key.pem");
      loaded.resolve({ ...material([TEST_TLS_CERT_PEM]), fingerprintSha256: "stale" });
      await firstWake;
      await clock.advanceBy(299);
      expect(mocks.load).toHaveBeenCalledOnce();
      await clock.advanceBy(1);
      expect(mocks.load).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledExactlyOnceWith(next.tlsOptions);
      expect(runtime.tlsOptions).toBe(acceptedOptions);
      expect(runtime.tlsOptions?.ca).toBe(TEST_TLS_CERT_PEM);
      expect(runtime.fingerprintSha256).toBe("same-leaf-fingerprint");
      expect(onRenewed).toHaveBeenCalledOnce();
    } finally {
      loaded.resolve(material());
      await Promise.all([firstWake, owner.stop(), scheduler.stop()]);
    }
  });

  it("fences a read when disabled and reconciles on re-enable without another file event", async () => {
    const { started, loaded } = deferNextRead();
    const next = material(TEST_TLS_CERT_PEM);
    mocks.load.mockResolvedValueOnce(next);
    const { owner, publish, watcher, onRenewed, clock, scheduler } = createRenewal();
    const firstWake = clock.advanceBy(300);
    try {
      await started.promise;
      owner.setEnabled(false);
      loaded.resolve({ ...material([TEST_TLS_CERT_PEM]), fingerprintSha256: "disabled" });
      watcher.emit("all", "change", "/synthetic/key.pem");
      await firstWake;
      await clock.advanceBy(300);
      expect(publish).not.toHaveBeenCalled();
      expect(mocks.load).toHaveBeenCalledOnce();
      owner.setEnabled(true);
      await clock.advanceBy(300);
      expect(publish).toHaveBeenCalledExactlyOnceWith(next.tlsOptions);
      expect(onRenewed).toHaveBeenCalledOnce();
    } finally {
      loaded.resolve(material());
      await Promise.all([firstWake, owner.stop(), scheduler.stop()]);
    }
  });
});
