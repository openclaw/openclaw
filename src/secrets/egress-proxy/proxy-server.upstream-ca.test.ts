import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { mintSecretSentinel } from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const proxies: SecretEgressProxyHandle[] = [];
const releases: Array<() => Promise<void>> = [];
const observations: string[] = [];
const secret = "synthetic-upstream-ca-credential";
const sentinel = mintSecretSentinel(secret, { label: "upstream-ca-test" });
let caFile: string;
let targetPort: number;
let wrongNamePort: number;
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
  async function start(upstreamCaFiles?: string[]) {
    const dir = dirs.make("openclaw-upstream-proxy-");
    for (const name of ["root-ca.pem", "root-ca-key.pem"]) {
      fs.copyFileSync(path.join(proxySeed, name), path.join(dir, name));
    }
    const proxy = await startSecretEgressProxyServer({
      caDir: dir,
      upstreamCaFiles,
      onAudit: () => {},
    });
    proxies.push(proxy);
    return proxy;
  }
  baseline = await start();
  extended = await start([caFile]);
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
  it("rejects the private origin without an explicit CA", async () => {
    const before = observations.length;
    expect(await request(baseline, targetPort)).toContain("\n502");
    expect(observations).toHaveLength(before);
  });
  it("accepts the configured CA and substitutes only at the destination", async () => {
    expect(await request(extended, targetPort)).toBe("authenticated\n200");
    expect(observations.at(-1)).toBe(`Bearer ${secret}`);
    expect(fs.readFileSync(clientCaFile, "utf8")).not.toContain(
      fs.readFileSync(caFile, "utf8").trim(),
    );
  });
  it("retains hostname verification and destination binding", async () => {
    const before = observations.length;
    expect(await request(extended, wrongNamePort)).toContain("\n502");
    expect(await request(extended, targetPort, ["example.invalid"])).toContain("\n502");
    expect(observations).toHaveLength(before);
  });
  it("fails before publishing a proxy for an unreadable CA", async () => {
    await expect(
      startSecretEgressProxyServer({
        caDir: dirs.make("openclaw-invalid-ca-proxy-"),
        upstreamCaFiles: [path.join(dirs.make("openclaw-ca-missing-"), "missing.pem")],
        onAudit: () => {},
      }),
    ).rejects.toThrow("upstreamCaFiles[0]");
  });
});
