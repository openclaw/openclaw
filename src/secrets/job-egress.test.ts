import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withSetupSecretEgress } from "../plugin-sdk/secret-egress-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { SecretEgressSentinelBinding } from "./egress-proxy/proxy-server.js";
import { resolveSecretSentinel } from "./sentinel.js";
import { writeSecretStoreEntries } from "./store/secret-store.js";

const startProxy = vi.hoisted(() =>
  vi.fn<typeof import("./egress-proxy/proxy-worker.js").startSecretEgressProxyWorker>(),
);
vi.mock("./egress-proxy/proxy-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./egress-proxy/proxy-worker.js")>()),
  startSecretEgressProxyWorker: startProxy,
}));
const revoke = vi.fn();
const stop = vi.fn(async () => {});
let state: OpenClawTestState;
let registered: readonly SecretEgressSentinelBinding[];
const hostProxy = "http://openclaw:synthetic-job-proxy-token@127.0.0.1:12345";

beforeAll(async () => {
  state = await createOpenClawTestState({ prefix: "job-egress-", applyEnv: true });
  await writeSecretStoreEntries({
    scope: { kind: "team" },
    updatedBy: "fixture",
    entries: [
      {
        name: "JOB_TOKEN",
        kind: "secret",
        value: "synthetic-job-token",
        allowedHosts: ["registry.example.test"],
      },
      {
        name: "JOB_PASSWORD",
        kind: "secret",
        value: "synthetic-job-password",
        allowedHosts: ["git.example.test"],
      },
      {
        name: "UNRELATED_TOKEN",
        kind: "secret",
        value: "synthetic-unrelated-token",
        allowedHosts: ["other.example.test"],
      },
      { name: "READABLE_TOKEN", kind: "env", value: "synthetic-readable-token" },
    ],
  });
});
afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});
beforeEach(() => {
  vi.clearAllMocks();
  registered = [];
  startProxy.mockImplementation(async ({ caDir }) => {
    const caPath = path.join(caDir, "trust-bundle.pem");
    await fs.writeFile(caPath, "synthetic-public-job-ca");
    return {
      caCertPath: caPath,
      proxyOrigin: "http://127.0.0.1:12345",
      getCertificateStatus: async () => ({
        state: "ready",
        caExpiresAt: "2030-01-01",
        failedCertificates: 0,
      }),
      registerProcess: async (bindings) => {
        assert.isDefined(bindings);
        registered = bindings;
        return { env: { HTTPS_PROXY: hostProxy, NODE_EXTRA_CA_CERTS: caPath }, revoke };
      },
      stop,
    };
  });
});
afterEach(() => vi.restoreAllMocks());

function options(signal = new AbortController().signal) {
  return {
    signal,
    secrets: {
      REGISTRY_TOKEN: { source: "store" as const, provider: "default", id: "JOB_TOKEN" },
      GIT_PASSWORD: { source: "store" as const, provider: "default", id: "JOB_PASSWORD" },
    },
  };
}

it("returns only selected sentinel env and public trust with host proxy credentials kept separate", async () => {
  expect(
    await withSetupSecretEgress(options(), async (egress) => {
      expect(Object.keys(egress.remoteEnv).toSorted()).toEqual(["GIT_PASSWORD", "REGISTRY_TOKEN"]);
      expect(resolveSecretSentinel(egress.remoteEnv.REGISTRY_TOKEN!)).toBe("synthetic-job-token");
      expect(resolveSecretSentinel(egress.remoteEnv.GIT_PASSWORD!)).toBe("synthetic-job-password");
      expect(registered.map(({ name, allowedHosts }) => ({ name, allowedHosts }))).toEqual([
        { name: "JOB_TOKEN", allowedHosts: ["registry.example.test"] },
        { name: "JOB_PASSWORD", allowedHosts: ["git.example.test"] },
      ]);
      expect(JSON.stringify(egress.remoteEnv)).not.toContain(hostProxy);
      expect(JSON.stringify(egress.remoteEnv)).not.toContain("127.0.0.1");
      expect(JSON.stringify(egress.remoteEnv)).not.toContain("synthetic-job-");
      expect(egress.hostEnv.HTTPS_PROXY).toBe(hostProxy);
      expect(egress.caBundle).toBe("synthetic-public-job-ca");
      egress.revoke();
      expect(revoke).toHaveBeenCalledOnce();
      return 23;
    }),
  ).toBe(23);
  expect(stop).toHaveBeenCalledOnce();
  await expect(fs.stat(startProxy.mock.calls[0]![0].caDir)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["MISSING_TOKEN", "READABLE_TOKEN"])(
  "rejects %s without a proxy or partial environment",
  async (id) => {
    const run = vi.fn();
    await expect(
      withSetupSecretEgress(
        { ...options(), secrets: { TOKEN: { source: "store", provider: "default", id } } },
        run,
      ),
    ).rejects.toThrow("protected shared-store entry");
    expect(startProxy).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  },
);

it("revokes cancellation before the job's termination listener and cleans up on failure", async () => {
  const controller = new AbortController();
  const entered = createDeferredCore();
  const finished = createDeferredCore();
  const terminate = vi.fn(() => expect(revoke).toHaveBeenCalledOnce());
  const running = withSetupSecretEgress(options(controller.signal), async () => {
    controller.signal.addEventListener("abort", terminate, { once: true });
    entered.resolve();
    await finished.promise;
    throw new Error("synthetic command failed");
  });
  await entered.promise;
  controller.abort();
  expect(terminate).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  finished.resolve();
  await expect(running).rejects.toThrow("synthetic command failed");
  expect(stop).toHaveBeenCalledOnce();
});

it("does not publish a grant if cancelled while registration is awaiting acknowledgement", async () => {
  const controller = new AbortController();
  const entered = createDeferredCore();
  const acknowledge = createDeferredCore();
  const start = startProxy.getMockImplementation()!;
  startProxy.mockImplementationOnce(async (params) => {
    const proxy = await start(params);
    const register = proxy.registerProcess;
    proxy.registerProcess = async (bindings) => {
      entered.resolve();
      await acknowledge.promise;
      return register(bindings);
    };
    return proxy;
  });
  const run = vi.fn();
  const running = withSetupSecretEgress(options(controller.signal), run);
  await entered.promise;
  controller.abort(new Error("synthetic job cancelled"));
  acknowledge.resolve();
  await expect(running).rejects.toThrow("synthetic job cancelled");
  expect(run).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});
