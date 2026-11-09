import { EventEmitter } from "node:events";
import { createServer } from "node:https";
import type { TlsOptions } from "node:tls";
import { beforeEach, expect, it, vi } from "vitest";
import * as pem from "../../test/helpers/tls-fixture.js";
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
const { TEST_TLS_CERT_PEM: cert, TEST_TLS_KEY_PEM: key } = pem;
const fingerprint = "same-leaf-fingerprint";

function material(ca?: TlsOptions["ca"]) {
  return {
    enabled: true,
    certPath: "/synthetic/cert.pem",
    keyPath: "/synthetic/key.pem",
    fingerprintSha256: fingerprint,
    tlsOptions: { cert, key, minVersion: "TLSv1.3", ...(ca ? { ca } : {}) },
  } satisfies GatewayTlsRuntime;
}

function createRenewal() {
  const started = createDeferredCore();
  const loaded = createDeferredCore<GatewayTlsRuntime>();
  mocks.load.mockImplementationOnce(() => {
    started.resolve();
    return loaded.promise;
  });
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const watcher = new EventEmitter();
  mocks.watchFile.mockImplementation((_path, _options, listener) => watcher.on("all", listener));
  mocks.unwatchFile.mockImplementation((_path, listener) => watcher.off("all", listener));
  const runtime = material();
  const server = createServer(runtime.tlsOptions);
  const publish = vi.spyOn(server, "setSecureContext");
  const onRenewed = vi.fn(async () => {});
  const log = { info: vi.fn(), warn: vi.fn() };
  const options = { scheduler, runtime, servers: [server], enabled: true, onRenewed, log };
  const owner = startGatewayTlsRenewal(options);
  if (!owner) {
    throw new Error("TLS renewal owner was not created");
  }
  const read = { started, loaded, wake: clock.advanceBy(300) };
  const events = { publish, onRenewed };
  return { owner, runtime, watcher, clock, scheduler, read, events };
}

let tls: ReturnType<typeof createRenewal>;
beforeEach(async () => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  tls = createRenewal();
  await tls.read.started.promise;
  return async () => {
    tls.read.loaded.resolve(material());
    await Promise.all([tls.read.wake, tls.owner.stop(), tls.scheduler.stop()]);
    expect(tls.watcher.listenerCount("all")).toBe(0);
  };
});

it.each(["renewal", "scheduler"] as const)(
  "joins a pending read on %s close without publishing it",
  async (closingOwner) => {
    let stopped = false;
    const stopping = (closingOwner === "renewal" ? tls.owner : tls.scheduler).stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    tls.read.loaded.resolve({ ...material(cert), fingerprintSha256: "retired" });
    await Promise.all([tls.read.wake, stopping]);
    expect([tls.events.publish.mock.calls, tls.events.onRenewed.mock.calls]).toEqual([[], []]);
    expect(tls.runtime.fingerprintSha256).toBe(fingerprint);
  },
);

it.each(["debounce", "re-enable"] as const)(
  "rejects stale reads and adopts same-leaf CA changes after %s",
  async (mode) => {
    const disabled = mode === "re-enable";
    const next = material(cert);
    mocks.load.mockResolvedValueOnce(next);
    const acceptedOptions = tls.runtime.tlsOptions;
    const stale = { ...material([cert]), fingerprintSha256: "stale" };
    if (disabled) {
      tls.owner.setEnabled(false);
    } else {
      tls.watcher.emit("all", "change", "/synthetic/cert.pem");
      await tls.clock.advanceBy(200);
    }
    tls.watcher.emit("all", "change", "/synthetic/key.pem");
    tls.read.loaded.resolve(stale);
    await tls.read.wake;
    await tls.clock.advanceBy(disabled ? 300 : 299);
    expect(tls.events.publish).not.toHaveBeenCalled();
    if (disabled) {
      tls.owner.setEnabled(true);
    }
    await tls.clock.advanceBy(disabled ? 300 : 1);
    expect(tls.events.publish).toHaveBeenCalledExactlyOnceWith(next.tlsOptions);
    expect(tls.runtime.tlsOptions).toBe(acceptedOptions);
    expect(tls.runtime).toMatchObject({ tlsOptions: { ca: cert }, fingerprintSha256: fingerprint });
    expect(tls.events.onRenewed).toHaveBeenCalledOnce();
  },
);
