import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, vi } from "vitest";
import type { startSecretEgressProxyWorker } from "./egress-proxy/proxy-worker.js";

export const publicCa = "synthetic-public-ca-bundle";
export const hostProxy = "http://openclaw:synthetic-proxy-token@127.0.0.1:12345";

const startProxy = vi.hoisted(() => vi.fn<typeof startSecretEgressProxyWorker>());
export { startProxy };
vi.mock("./egress-proxy/proxy-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./egress-proxy/proxy-worker.js")>()),
  startSecretEgressProxyWorker: startProxy,
}));

export function useEgressProxyMock() {
  const revoke = vi.fn();
  const proxy = {
    caCertPath: "",
    proxyOrigin: "http://127.0.0.1:12345",
    getCertificateStatus: async () => ({
      state: "ready" as const,
      caExpiresAt: "2030-01-01",
      failedCertificates: 0,
    }),
    registerProcess:
      vi.fn<Awaited<ReturnType<typeof startSecretEgressProxyWorker>>["registerProcess"]>(),
    stop: vi.fn(async () => {}),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    startProxy.mockImplementation(async ({ caDir }) => {
      proxy.caCertPath = path.join(caDir, "trust-bundle.pem");
      await fs.writeFile(proxy.caCertPath, publicCa);
      return proxy;
    });
    proxy.registerProcess.mockImplementation(async () => ({
      env: { HTTPS_PROXY: hostProxy, NODE_EXTRA_CA_CERTS: proxy.caCertPath },
      revoke,
    }));
  });
  return { proxy, revoke };
}
