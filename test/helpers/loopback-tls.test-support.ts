import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Fresh test-only CA and loopback leaf; callers own private-state cleanup and trust scope. */
export function createLoopbackTlsFixture(
  root: string,
  subjectAltName = "DNS:localhost,IP:127.0.0.1",
) {
  const tlsRoot = join(root, "tls");
  const caKey = join(tlsRoot, "ca-key.pem");
  const caCert = join(tlsRoot, "ca-cert.pem");
  const serverKey = join(tlsRoot, "server-key.pem");
  const serverCsr = join(tlsRoot, "server.csr");
  const serverCert = join(tlsRoot, "server-cert.pem");
  const serverExt = join(tlsRoot, "server.ext");
  mkdirSync(tlsRoot);
  const openssl = (command: string, options: Record<string, string | string[] | true>) => {
    const args = Object.entries(options).flatMap(([key, value]) =>
      value === true ? ["-" + key] : [value].flat().flatMap((item) => ["-" + key, item]),
    );
    execFileSync("openssl", [command, ...args], { stdio: "ignore" });
  };
  const keyOptions = { newkey: "rsa:2048", nodes: true, sha256: true } as const;
  openssl("req", {
    ...keyOptions,
    x509: true,
    days: "1",
    subj: "/CN=OpenClaw watchOS survivor test CA",
    addext: ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign"],
    keyout: caKey,
    out: caCert,
  });
  openssl("req", { ...keyOptions, subj: "/CN=localhost", keyout: serverKey, out: serverCsr });
  writeFileSync(
    serverExt,
    [
      "basicConstraints=critical,CA:FALSE",
      "subjectAltName=" + subjectAltName,
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
  );
  openssl("x509", {
    req: true,
    in: serverCsr,
    CA: caCert,
    CAkey: caKey,
    CAcreateserial: true,
    days: "1",
    sha256: true,
    extfile: serverExt,
    out: serverCert,
  });
  return {
    caCert,
    cert: readFileSync(serverCert),
    key: readFileSync(serverKey),
  };
}
