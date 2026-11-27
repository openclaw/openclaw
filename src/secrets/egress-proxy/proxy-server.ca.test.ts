import { once } from "node:events";
import fs from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import path from "node:path";
import tls from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { PROXY_ENV_KEYS } from "../../infra/net/proxy-env.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { mintSecretSentinel } from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";
import { basicProxyAuth, registeredPassword } from "./proxy-server.test-support.js";

const dirs = createTempDirTracker();
afterEach(() => {
  dirs.cleanup();
  vi.unstubAllEnvs();
});

it("trusts configured private CAs without relaxing upstream TLS verification", async () => {
  for (const key of [...PROXY_ENV_KEYS, "NO_PROXY", "no_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  const dir = dirs.make("openclaw-egress-configured-ca-");
  const upstreamDir = path.join(dir, "upstream");
  const upstreamCa = await ensureSecretEgressProxyCa(upstreamDir);
  const leaf = await generateLocalProxyLeaf({
    certDir: upstreamDir,
    ca: upstreamCa,
    hostname: "localhost",
  });
  const observed: Array<string | undefined> = [];
  const origin = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer(leaf, (req, res) => {
        observed.push(req.headers.authorization);
        res.end("ok");
      }),
  });
  const proxies: SecretEgressProxyHandle[] = [];
  const defaults = tls.getCACertificates("default");
  const secret = "synthetic-private-ca-credential";
  const sentinel = mintSecretSentinel(secret, { label: "private-ca" });
  async function startProxy(name: string) {
    const proxy = await startSecretEgressProxyServer({
      caDir: path.join(dir, name),
      onAudit: () => {},
    });
    proxies.push(proxy);
    return proxy.registerProcess([
      { name: "SERVICE_API_KEY", sentinel, allowedHosts: ["localhost", "127.0.0.1"] },
    ]).env;
  }
  function forward(env: Record<string, string>, hostname = "localhost") {
    const endpoint = new URL(env.HTTPS_PROXY!);
    return new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          hostname: endpoint.hostname,
          port: endpoint.port,
          agent: false,
          path: `https://${hostname}:${origin.claim.port}/`,
          headers: {
            "Proxy-Authorization": basicProxyAuth(registeredPassword(env)),
            Authorization: `Bearer ${sentinel}`,
          },
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode));
          res.once("error", reject);
        },
      );
      req.once("error", reject);
      req.end();
    });
  }
  try {
    await expect(forward(await startProxy("unconfigured"))).resolves.toBe(502);
    expect(observed).toEqual([]);
    tls.setDefaultCACertificates([...defaults, fs.readFileSync(upstreamCa.certPath, "utf8")]);
    const env = await startProxy("configured");
    await expect(forward(env)).resolves.toBe(200);
    expect(observed).toEqual([`Bearer ${secret}`]);

    // Subprocess clients must also trust the private origin through the exported bundle.
    const client = tls.connect({
      host: "localhost",
      port: origin.claim.port,
      servername: "localhost",
      ca: fs.readFileSync(env.NODE_EXTRA_CA_CERTS!),
    });
    try {
      await once(client, "secureConnect");
      expect(client.authorized).toBe(true);
    } finally {
      client.destroy();
    }
    // The destination is allowed, but its IP does not match the localhost certificate.
    await expect(forward(env, "127.0.0.1")).resolves.toBe(502);
    expect(observed).toHaveLength(1);

    // A separately generated issuer must still be rejected.
    const unknownDir = path.join(dir, "unknown");
    const unknownCa = await ensureSecretEgressProxyCa(unknownDir);
    origin.listener.setSecureContext(
      await generateLocalProxyLeaf({ certDir: unknownDir, ca: unknownCa, hostname: "localhost" }),
    );
    await expect(forward(env)).resolves.toBe(502);
    expect(observed).toHaveLength(1);
  } finally {
    tls.setDefaultCACertificates(defaults);
    for (const proxy of proxies) {
      await proxy.stop();
    }
    origin.listener.closeAllConnections();
    await origin.releaseListener();
    await origin.claim.release();
  }
});
