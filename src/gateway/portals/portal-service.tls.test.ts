import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as advertisedLanHost from "../../infra/advertised-lan-host.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { createGatewayPortalService, type GatewayPortalService } from "./portal-service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const services: GatewayPortalService[] = [];
let certificate: { cert: string; key: string };
let ipCertificate: { cert: string; key: string };
let wildcardCertificate: { cert: string; key: string };

// Fresh material keeps CA, expiry, and hostname checks enabled in every case.
function createCertificate(subjectAltName: string) {
  const directory = tempDirs.make("portal-direct-tls-");
  const certPath = path.join(directory, "cert.pem");
  const keyPath = path.join(directory, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=gateway.example.test",
      "-addext",
      `subjectAltName=${subjectAltName}`,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
}

beforeAll(() => {
  certificate = createCertificate("DNS:gateway.example.test,DNS:alternate.example.test");
  ipCertificate = createCertificate("IP:127.0.0.1");
  wildcardCertificate = createCertificate("DNS:*.example.test");
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.closeAll()));
  vi.restoreAllMocks();
});

// Only DNS routing is local to the fixture: CA, expiry, and URL hostname checks stay enabled.
async function readPortal(url: string, ca = certificate.cert) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      url,
      {
        ca,
        family: 4,
        lookup: (_host, _options, callback) => callback(null, "127.0.0.1", 4),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("direct HTTPS portal publication", () => {
  it.each(["ip", "wildcard", "chain"] as const)(
    "retains verified %s certificate access",
    async (kind) => {
      const material =
        kind === "ip" ? ipCertificate : kind === "wildcard" ? wildcardCertificate : certificate;
      const hostname = kind === "ip" ? "127.0.0.1" : "gateway.example.test";
      const service = createGatewayPortalService({
        httpBindHosts: ["127.0.0.1"],
        httpServers: [],
        tlsOptions: { ...material, cert: kind === "chain" ? [material.cert] : material.cert },
        gatewayOrigins: kind === "wildcard" ? ["*", `https://${hostname}`] : [],
      });
      services.push(service);
      const portal = await service.open({ targetPort: 3000 });
      expect(new URL(portal.publicUrl).hostname).toBe(hostname);
      expect((await readPortal(portal.publicUrl, material.cert)).status).toBe(401);
    },
  );

  it.each(["0.0.0.0", "127.0.0.1"])(
    "publishes a certificate-valid DNS name for bind %s",
    async (bindHost) => {
      // Keep the advertised IP locally reachable so the broken candidate fails on TLS, not routing.
      vi.spyOn(advertisedLanHost, "resolveAdvertisedLanHostCore").mockResolvedValue("127.0.0.2");
      await withServer(
        (_req, res) => res.end("direct TLS app"),
        async (targetUrl) => {
          const service = createGatewayPortalService({
            httpBindHosts: [bindHost],
            httpServers: [],
            tlsOptions: certificate,
          });
          services.push(service);
          const portal = await service.open({ targetPort: Number(new URL(targetUrl).port) });
          expect(await readPortal(portal.url)).toEqual({ status: 200, body: "direct TLS app" });
          expect(new URL(portal.publicUrl).hostname).toBe("gateway.example.test");
          expect(service.list()[0]?.publicUrl).toBe(portal.publicUrl);
          expect((await readPortal(portal.publicUrl)).status).toBe(401);
        },
      );
    },
  );

  it("prefers a configured certificate-valid Gateway name, ignoring unrelated origins", async () => {
    const service = createGatewayPortalService({
      httpBindHosts: ["127.0.0.1"],
      httpServers: [],
      tlsOptions: certificate,
      gatewayOrigins: ["https://unrelated.example.test", "https://alternate.example.test:8443"],
    });
    services.push(service);
    const portal = await service.open({ targetPort: 3000 });
    expect(new URL(portal.publicUrl).hostname).toBe("alternate.example.test");
    expect((await readPortal(portal.publicUrl)).status).toBe(401);
  });
});
