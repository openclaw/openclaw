import { X509Certificate } from "node:crypto";
import https from "node:https";
import { describe, expect, it } from "vitest";
import {
  NodeWorkerTransferHttpError,
  withNodeWorkerTransferHttpRequest,
} from "./node-worker-transfer-http.js";

const transferServerKey = `-----BEGIN PRIVATE KEY-----`; // pragma: allowlist secret
const transferServerKeyPem = `${transferServerKey}
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCaN4bY7N5bfB0u
do1P38Y8OvFNuBjmEMu3G6ASPsigwW6iRYqYJ8Wt56UJ9qD6kzfu21hX63GFUkA7
2NQqjOcvO8HZzgQH/Gi0z8a4Im9j2FSxNw7O7jd14wDtYJDxicVXeaEgVYRDwP5q
QgszYxM9uzn1wOs7gpLWOpSCxz9SKO3+W2OlPo1RkGVA7rNy19VqdkYdy3C1O7WI
6RD7UFsf8d91GYPnWqgfXhFMjqsmmXHcMZ8X8vBIHi4ivcnX7FXxxyBgHPAnMoSD
uJH/2BS9dN/L32KX2hQyhYTqlEttjArIFue4Q6qp5IXRF3Q+Sj8RpHKwDSg2mJwX
6rrqz5cdAgMBAAECggEAId+Oa/ljQd76HemGUoQJa9Nai0KjnW0VAew8daV6teym
21fBAHjD79XQp2aXp1JM19cwCWe6sJkHaN3QhGQcp4BNrQSWWBa1/PkiYfGWW+z5
dU9tnkAuyGMLIhiy3YrwYK1jmdGO0r8CYt6MzUW2xTlpmrQ8Nv8QN6P4WN1g6C+j
slbG9aa9hEnBDAHj1Cq0+bm5GZMWKDlxcERffUvuRuZg/ENcq1EWB5TNXgEps9go
wVhw8EHx2p9B6obBdfBJWSKTDWrMpPouSduQ57g1A9HdZBr7xxval8lQBvZ+6vsz
YISb+V6xYLnHEGbzPZs0vTM89Vmce4ogLLA9W28RwQKBgQDYluJ/A/03mKKPdnDz
hJBvBy5PmAgZpdVB/3IacD+CVUVR8qYQSv5+uDJElqBZFfTrpLNxyEnUUkTm+xXq
XVnN+rSOlVIxUEbRnkOW0SvlauLq3f+3JMo4flJMAqhsWTYtZaL+N/pHnTatja/9
GnUVYTZeUTb6jGqnoDmocRDR8QKBgQC2Rzi0mwlCUdAYKjktfye98sR0KS0tWewM
5KV48OgzR4qR1mKTagkoabwnJT/CLMeDLzzVbaDtNsszhnfEgYfI1V+SGDnXOa2X
r6nAGVRxjKwmFaZWGkXxzEf/TH+EEgoHEz5I5QVZmUtFpjGaqZPs19JlYjkmKEHF
d8XzINXr7QKBgBdw9SCUGPLMdUObqQviHBO4Lj31EWNdPGCBOiM8ZNNBUVhWL7zx
sOucGeysdLxPkQtz7uvwpnTxVn29TRjpc4/Eg4gvBw9JRfDn9R68ksiosdiDoGp8
89n7agLKAtp/KUruhh6HhnH7xPAxtotpMqTWuaCpn46sZdqwj6z4V76xAoGAXxqV
+ZWSpSmum40cPCLGB5Ns8Pay/aCXSrrZo1p+rJK9OA5VbHi8wns4kmwa8iMPDeFN
qkYC2wHlz8JvJvY2dJDvxnghZaxQaH5c4T/WEVDGWTCekvouWFSvlALD3ZLT7JEb
xEjKG8+huHtYEkw8RCzvN7qh+siyWGd/vrT5KJkCgYAVT3LBtIHdZB3YU9o1Qaiv
nOBmypZr+JLMLY1QQwJ/R7sZVM0IdEXBWJpN1hp36J2Eed//HEeyn6gFO1toXJJz
Cyukt/nOu26/asc99TTOe5xbTjshH5Srb+1kfZsgaBQ/1cTsrRl3FOEKk7tgxGtG
VWMBkcN+qVqTG7FQcUiieQ==
-----END PRIVATE KEY-----`;

const transferServerCert = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUaIKLoSsHYKklupDh0MzwDo0sI3UwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAxMDE2MTc0M1oXDTM2MTAw
NzE2MTc0M1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAmjeG2OzeW3wdLnaNT9/GPDrxTbgY5hDLtxugEj7IoMFu
okWKmCfFreelCfag+pM37ttYV+txhVJAO9jUKoznLzvB2c4EB/xotM/GuCJvY9hU
sTcOzu43deMA7WCQ8YnFV3mhIFWEQ8D+akILM2MTPbs59cDrO4KS1jqUgsc/Uijt
/ltjpT6NUZBlQO6zctfVanZGHctwtTu1iOkQ+1BbH/HfdRmD51qoH14RTI6rJplx
3DGfF/LwSB4uIr3J1+xV8ccgYBzwJzKEg7iR/9gUvXTfy99il9oUMoWE6pRLbYwK
yBbnuEOqqeSF0Rd0Pko/EaRysA0oNpicF+q66s+XHQIDAQABo28wbTAdBgNVHQ4E
FgQU0m1kiFLEuWJH1EoU1gU3FIF2zJowHwYDVR0jBBgwFoAU0m1kiFLEuWJH1EoU
1gU3FIF2zJowDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAB46J28OZrh6I1cxigGQDtLs5vb0rt+J
OaVoidR0yGtIlN/Jc5bqmjN579HZXEIDh/r59/jeMWwudrJpxTZtbJtpZQ+JUTNS
AzK09JKcd2MUgPZbGxwyEZ9raxWNh5xinNhzkxNADgvFQ/ntPfwQWG5ZPUV/8Him
929IWNljZwCqkrbeikBRyjCr8OXEld1HkvmtzW5kX0yp/wKHi+mR65Yz3jZCJbmw
+Z2tzvp9gtB3uY/Ihy7gvtLZdL69IFZaAFF7cv5bioE1HJLMqgBfn2d68tHaJCGk
a/VH9Yr3g+2nK2zmRfcprvkM4BcFvvFH4+YUyV2F/H90/YrDHxWw2B8=
-----END CERTIFICATE-----`;

const transferCertFingerprint = new X509Certificate(transferServerCert).fingerprint256;

async function startTransferServer() {
  const server = https.createServer({
    key: transferServerKeyPem,
    cert: transferServerCert,
  });
  server.on("request", (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("transfer-body");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("worker transfer test server did not bind");
  }
  return {
    gatewayUrl: `wss://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function transfer(params: { gatewayUrl: string; tlsFingerprint?: string }) {
  return withNodeWorkerTransferHttpRequest(
    {
      gatewayUrl: params.gatewayUrl,
      routePath: "/worker-transfer",
      method: "GET",
      token: "test-token",
      tlsFingerprint: params.tlsFingerprint,
    },
    async (response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        chunks.push(Buffer.from(chunk));
      }
      return {
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      };
    },
  );
}

describe("node worker transfer TLS pinning", () => {
  it("verifies the peer certificate against a configured fingerprint", async () => {
    const server = await startTransferServer();
    try {
      const response = await transfer({
        gatewayUrl: server.gatewayUrl,
        tlsFingerprint: transferCertFingerprint,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("transfer-body");
    } finally {
      await server.close();
    }
  });

  it("keeps certificate validation on when the fingerprint is whitespace-only", async () => {
    const server = await startTransferServer();
    try {
      // Without the fingerprint gate this succeeds against an untrusted
      // self-signed certificate because pin mode disabled validation.
      await expect(
        transfer({ gatewayUrl: server.gatewayUrl, tlsFingerprint: "   " }),
      ).rejects.toThrow(/self[- ]?signed|unable to (?:verify|get local issuer)/i);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-blank invalid fingerprint before connecting", async () => {
    const server = await startTransferServer();
    try {
      const error = await transfer({
        gatewayUrl: server.gatewayUrl,
        tlsFingerprint: "not-a-fingerprint",
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(NodeWorkerTransferHttpError);
      expect((error as NodeWorkerTransferHttpError).reason).toBe("invalid-tls-fingerprint");
    } finally {
      await server.close();
    }
  });
});
