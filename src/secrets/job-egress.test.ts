import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withSetupSecretEgress } from "../plugin-sdk/secret-egress-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { SecretEgressSentinelBinding } from "./egress-proxy/proxy-server.js";
import { resolveSecretSentinel } from "./sentinel.js";
import { inspectSetupSecretMigration } from "./setup-secret-migration.js";
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
let beforeRegister: (() => Promise<void>) | undefined;
const hostProxy = "http://openclaw:synthetic-job-proxy-token@127.0.0.1:12345";
const protectedEntry = (name: string, value: string, ...allowedHosts: string[]) => ({
  name,
  value,
  allowedHosts,
  kind: "secret" as const,
});

beforeAll(async () => {
  state = await createOpenClawTestState({ prefix: "job-egress-", applyEnv: true });
  await writeSecretStoreEntries({
    scope: { kind: "team" },
    updatedBy: "fixture",
    entries: [
      protectedEntry("JOB_TOKEN", "synthetic-job-token", "registry.example.test"),
      protectedEntry("JOB_PASSWORD", "synthetic-job-password", "git.example.test"),
      protectedEntry("UNRELATED_TOKEN", "synthetic-unrelated-token", "other.example.test"),
      { name: "READABLE_TOKEN", kind: "env", value: "synthetic-readable-token" },
      { name: "UNBOUND_TOKEN", kind: "secret", value: "synthetic-unbound-token" },
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
  beforeRegister = undefined;
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
        if (beforeRegister) {
          await beforeRegister();
        }
        assert.isDefined(bindings);
        registered = bindings;
        return { env: { HTTPS_PROXY: hostProxy, NODE_EXTRA_CA_CERTS: caPath }, revoke };
      },
      stop,
    };
  });
});

function options(
  signal = new AbortController().signal,
  selection: Record<string, string> = { npm_token: "JOB_TOKEN", GIT_PASSWORD: "JOB_PASSWORD" },
) {
  return {
    signal,
    secrets: Object.fromEntries(
      Object.entries(selection).map(([name, id]) => [
        name,
        { source: "store" as const, provider: "default", id },
      ]),
    ),
  };
}

async function expectRejectedSecret(id: string, message: string) {
  const run = vi.fn();
  await expect(withSetupSecretEgress(options(undefined, { TOKEN: id }), run)).rejects.toThrow(
    message,
  );
  expect(startProxy).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
}

it("returns only selected POSIX sentinel env and public trust with host proxy credentials separate", async () => {
  const result = await withSetupSecretEgress(options(), async (egress) => {
    expect(Object.keys(egress.remoteEnv).toSorted()).toEqual(["GIT_PASSWORD", "npm_token"]);
    expect(resolveSecretSentinel(egress.remoteEnv.npm_token!)).toBe("synthetic-job-token");
    expect(resolveSecretSentinel(egress.remoteEnv.GIT_PASSWORD!)).toBe("synthetic-job-password");
    expect(registered.map(({ name, allowedHosts }) => ({ name, allowedHosts }))).toEqual([
      { name: "JOB_TOKEN", allowedHosts: ["registry.example.test"] },
      { name: "JOB_PASSWORD", allowedHosts: ["git.example.test"] },
    ]);
    for (const privateValue of [hostProxy, "127.0.0.1", "synthetic-job-"]) {
      expect(JSON.stringify(egress.remoteEnv)).not.toContain(privateValue);
    }
    expect(egress.hostEnv.HTTPS_PROXY).toBe(hostProxy);
    expect(egress.caBundle).toBe("synthetic-public-job-ca");
    egress.revoke();
    expect(revoke).toHaveBeenCalledOnce();
    return 23;
  });
  expect(result).toBe(23);
  expect(stop).toHaveBeenCalledOnce();
  await expect(fs.stat(startProxy.mock.calls[0]![0].caDir)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each([
  ["MISSING_TOKEN", "protected shared-store entry"],
  ["READABLE_TOKEN", "protected shared-store entry"],
  ["UNBOUND_TOKEN", "--allow-host <host>"],
])("rejects %s without a proxy or partial environment", expectRejectedSecret);

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
  beforeRegister = () => {
    entered.resolve();
    return acknowledge.promise;
  };
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

it("inspects setup migration through protected-store ownership without returning secret material", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, JOB_TOKEN: "synthetic-job-token" };
  const inspect = (names = ["JOB_TOKEN"], candidateEnv = env) =>
    inspectSetupSecretMigration({ names, env: candidateEnv });
  const ready = [{ name: "JOB_TOKEN", status: "ready" }];
  expect(
    await inspect(["JOB_TOKEN", "UNBOUND_TOKEN", "READABLE_TOKEN", "MISSING", "lowercase"]),
  ).toEqual([
    { name: "JOB_TOKEN", status: "ready" },
    { name: "UNBOUND_TOKEN", status: "missing-bindings" },
    { name: "READABLE_TOKEN", status: "missing" },
    { name: "MISSING", status: "missing" },
    { name: "lowercase", status: "missing" },
  ]);
  expect(await inspect(undefined, { ...env, JOB_TOKEN: "different-fixture" })).toEqual([
    { name: "JOB_TOKEN", status: "conflicting-value" },
  ]);
  delete env.JOB_TOKEN;
  expect(await inspect()).toEqual(ready);
  await expect(inspect(Array.from({ length: 17 }, (_, index) => `TOKEN_${index}`))).rejects.toThrow(
    "at most 16",
  );
});
