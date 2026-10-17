import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { getCACertificates, rootCertificates, setDefaultCACertificates } from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { sealSecretSentinel } from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const proxies: SecretEgressProxyHandle[] = [];
const releases: Array<() => Promise<void>> = [];
const observations: string[] = [];
const secret = "synthetic-upstream-ca-credential";
const sentinel = sealSecretSentinel(secret, { label: "upstream-ca-test" });
let caFile: string;
let targetPort: number;
let wrongNamePort: number;
let foreignPort: number;
let baseline: SecretEgressProxyHandle;
let extended: SecretEgressProxyHandle;
let clientCaFile: string;

beforeAll(async () => {
  const caDir = dirs.make("openclaw-private-upstream-");
  const ca = await ensureSecretEgressProxyCa(caDir);
  caFile = ca.certPath;
  for (const hostname of ["localhost", "wrong-name.invalid"]) {
    const leaf = await generateLocalProxyLeaf({ certDir: caDir, ca, hostname });
    const reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer(leaf, (incomingRequest, response) => {
          observations.push(incomingRequest.headers.authorization ?? "");
          response.end(
            incomingRequest.headers.authorization === `Bearer ${secret}`
              ? "authenticated"
              : "missing",
          );
        }),
    });
    releases.push(async () => {
      reservation.listener.closeAllConnections();
      await reservation.releaseListener();
      await reservation.claim.release();
    });
    if (hostname === "localhost") {
      targetPort = reservation.claim.port;
    } else {
      wrongNamePort = reservation.claim.port;
    }
  }
  // Reuse a proxy CA seed without trusting the independent upstream CA by default.
  const proxySeed = dirs.make("openclaw-upstream-proxy-seed-");
  await ensureSecretEgressProxyCa(proxySeed);
  async function start() {
    const dir = dirs.make("openclaw-upstream-proxy-");
    for (const name of ["root-ca.pem", "root-ca-key.pem"]) {
      fs.copyFileSync(path.join(proxySeed, name), path.join(dir, name));
    }
    const proxy = await startSecretEgressProxyServer({
      caDir: dir,
      onAudit: () => {},
    });
    proxies.push(proxy);
    return proxy;
  }
  baseline = await start();
  const configuredCAs = getCACertificates("default");
  // Exercise the actual Node default-CA owner, not a mocked TLS API. The proxy
  // snapshots it at startup and must also retain public bundled roots.
  setDefaultCACertificates([fs.readFileSync(caFile, "utf8")]);
  try {
    extended = await start();
  } finally {
    setDefaultCACertificates(configuredCAs);
  }
  const foreignDir = dirs.make("openclaw-untrusted-upstream-");
  const foreignCa = await ensureSecretEgressProxyCa(foreignDir);
  const foreignLeaf = await generateLocalProxyLeaf({
    certDir: foreignDir,
    ca: foreignCa,
    hostname: "localhost",
  });
  const foreign = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer(foreignLeaf, (req, res) => {
        observations.push(req.headers.authorization ?? "");
        res.end("untrusted");
      }),
  });
  foreignPort = foreign.claim.port;
  releases.push(async () => {
    foreign.listener.closeAllConnections();
    await foreign.releaseListener();
    await foreign.claim.release();
  });
  clientCaFile = extended.registerProcess().env.CURL_CA_BUNDLE!;
});
afterAll(async () => {
  await Promise.all(proxies.map((proxy) => proxy.stop()));
  await Promise.all(releases.map((release) => release()));
});

async function request(proxy: SecretEgressProxyHandle, port: number, allowedHosts = ["localhost"]) {
  const grant = proxy.registerProcess([{ sentinel, name: "SYNTHETIC", allowedHosts }]);
  try {
    const { stdout } = await promisify(execFile)(
      "curl",
      [
        "--noproxy",
        "",
        "--connect-timeout",
        "3",
        "--max-time",
        "8",
        "-sS",
        "-w",
        "\n%{http_code}",
        `https://localhost:${port}/resources`,
        "-H",
        `Authorization: Bearer ${sentinel}`,
      ],
      { env: { ...process.env, ...grant.env } },
    );
    return stdout;
  } finally {
    grant.revoke();
  }
}

describe("upstream CA through verified CONNECT on a non-443 port", () => {
  it("rejects the private origin without a configured default CA", async () => {
    const before = observations.length;
    expect(await request(baseline, targetPort)).toContain("\n502");
    expect(observations).toHaveLength(before);
  });
  it("accepts the Node-configured CA and substitutes only at the destination", async () => {
    expect(await request(extended, targetPort)).toBe("authenticated\n200");
    expect(observations.at(-1)).toBe(`Bearer ${secret}`);
    expect(fs.readFileSync(clientCaFile, "utf8")).toContain(fs.readFileSync(caFile, "utf8").trim());
  });
  it("retains hostname verification and destination binding", async () => {
    const before = observations.length;
    expect(await request(extended, wrongNamePort)).toContain("\n502");
    expect(await request(extended, targetPort, ["example.invalid"])).toContain("\n502");
    expect(observations).toHaveLength(before);
  });
  it("retains bundled roots when Node default trust has only the configured CA", () => {
    const bundle = fs.readFileSync(clientCaFile, "utf8");
    expect(rootCertificates.every((certificate) => bundle.includes(certificate))).toBe(true);
  });
  it("never delivers a credential to an unrelated issuer or after grant revocation", async () => {
    const before = observations.length;
    expect(await request(extended, foreignPort)).toContain("\n502");
    const grant = extended.registerProcess([
      { sentinel, name: "SYNTHETIC", allowedHosts: ["localhost"] },
    ]);
    grant.revoke();
    await expect(
      promisify(execFile)(
        "curl",
        [
          "--noproxy",
          "",
          "--max-time",
          "3",
          "-sS",
          `https://localhost:${targetPort}/resources`,
          "-H",
          `Authorization: Bearer ${sentinel}`,
        ],
        { env: { ...process.env, ...grant.env } },
      ),
    ).rejects.toThrow();
    expect(observations).toHaveLength(before);
  });
});
