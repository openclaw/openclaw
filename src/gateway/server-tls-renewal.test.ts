import { EventEmitter } from "node:events";
import { createServer } from "node:https";
import type { TlsOptions } from "node:tls";
import { beforeEach, expect, it, vi } from "vitest";
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
  return {
    enabled: true,
    certPath: "/synthetic/cert.pem",
    keyPath: "/synthetic/key.pem",
    fingerprintSha256: "same-leaf-fingerprint",
    tlsOptions: {
      cert: TEST_TLS_CERT_PEM,
      key: TEST_TLS_KEY_PEM,
      minVersion: "TLSv1.3",
      ...(ca ? { ca } : {}),
    },
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
  return {
    owner,
    runtime,
    publish,
    watcher,
    onRenewed,
    clock,
    scheduler,
    started,
    loaded,
    wake: clock.advanceBy(300),
  };
}

let tls: ReturnType<typeof createRenewal>;
beforeEach(async () => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  tls = createRenewal();
  await tls.started.promise;
  return async () => {
    tls.loaded.resolve(material());
    await Promise.all([tls.wake, tls.owner.stop(), tls.scheduler.stop()]);
    expect(tls.watcher.listenerCount("all")).toBe(0);
  };
});

it.each(["renewal", "scheduler"] as const)(
  "joins a pending read on %s close without publishing it",
  async (closingOwner) => {
    expect(mocks.load).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = (closingOwner === "renewal" ? tls.owner : tls.scheduler).stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    tls.loaded.resolve({ ...material(TEST_TLS_CERT_PEM), fingerprintSha256: "retired" });
    await Promise.all([tls.wake, stopping]);
    expect(stopped).toBe(true);
    expect([tls.publish.mock.calls, tls.onRenewed.mock.calls]).toEqual([[], []]);
    expect(tls.runtime.fingerprintSha256).toBe("same-leaf-fingerprint");
  },
);

it("debounces file changes, ignores an older read, and adopts a CA change with the same leaf", async () => {
  const next = material(TEST_TLS_CERT_PEM);
  mocks.load.mockResolvedValueOnce(next);
  const acceptedOptions = tls.runtime.tlsOptions;
  tls.watcher.emit("all", "change", "/synthetic/cert.pem");
  await tls.clock.advanceBy(200);
  tls.watcher.emit("all", "change", "/synthetic/key.pem");
  tls.loaded.resolve({ ...material([TEST_TLS_CERT_PEM]), fingerprintSha256: "stale" });
  await tls.wake;
  await tls.clock.advanceBy(299);
  expect(mocks.load).toHaveBeenCalledOnce();
  await tls.clock.advanceBy(1);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(tls.publish).toHaveBeenCalledExactlyOnceWith(next.tlsOptions);
  expect(tls.runtime.tlsOptions).toBe(acceptedOptions);
  expect(tls.runtime).toMatchObject({
    tlsOptions: { ca: TEST_TLS_CERT_PEM },
    fingerprintSha256: "same-leaf-fingerprint",
  });
  expect(tls.onRenewed).toHaveBeenCalledOnce();
});

it("fences a read when disabled and reconciles on re-enable without another file event", async () => {
  const next = material(TEST_TLS_CERT_PEM);
  mocks.load.mockResolvedValueOnce(next);
  tls.owner.setEnabled(false);
  tls.loaded.resolve({ ...material([TEST_TLS_CERT_PEM]), fingerprintSha256: "disabled" });
  tls.watcher.emit("all", "change", "/synthetic/key.pem");
  await tls.wake;
  await tls.clock.advanceBy(300);
  expect(tls.publish).not.toHaveBeenCalled();
  expect(mocks.load).toHaveBeenCalledOnce();
  tls.owner.setEnabled(true);
  await tls.clock.advanceBy(300);
  expect(tls.publish).toHaveBeenCalledExactlyOnceWith(next.tlsOptions);
  expect(tls.onRenewed).toHaveBeenCalledOnce();
});
