import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import type { Duplex } from "node:stream";
import type { SecureContextOptions } from "node:tls";
import { LruCache } from "../../infra/lru-cache.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";

const MAX_CACHED_LEAVES = 128;
const LEAF_RENEWAL_MARGIN_MS = 60 * 60_000;
const CA_WARNING_MARGIN_MS = 7 * 24 * 60 * 60_000;
const CERTIFICATE_RETRY_MESSAGE =
  "Secret egress proxy could not prepare a TLS certificate. Check Gateway logs, OpenSSL availability, and the system clock, then retry the request.";
const CA_RESTART_MESSAGE =
  "Secret egress proxy CA is expired or not yet valid. Check the system clock, then restart the Gateway to create a new process trust chain.";

export class SecretEgressCertificateError extends Error {}

type CertificateValidity = { notBefore: number; notAfter: number };
type CachedLeaf = { cert: Buffer; key: Buffer; validity: CertificateValidity };
export type SecretEgressCertificateStatus = {
  state: "ready" | "degraded";
  caExpiresAt: string;
  failedCertificates: number;
  message?: string;
};
export type SecretEgressTlsEndpoint = {
  acceptConnection: (socket: Duplex) => void;
  close: () => void;
  setSecureContext: (options: SecureContextOptions) => void;
};
export type SecretEgressTlsContext = {
  get: () => Promise<SecretEgressTlsEndpoint | undefined>;
  close: () => void;
};

function readValidity(pem: string | Buffer): CertificateValidity {
  const certificate = new X509Certificate(pem);
  return {
    notBefore: certificate.validFromDate.getTime(),
    notAfter: certificate.validToDate.getTime(),
  };
}

function validAt(validity: CertificateValidity, now: number): boolean {
  return validity.notBefore <= now && now < validity.notAfter;
}

/** Owns one process trust chain and the certificate work using its private key. */
export async function createSecretEgressCertificates(certDir: string) {
  const ca = await ensureSecretEgressProxyCa(certDir);
  const caPem = fs.readFileSync(ca.certPath, "utf8");
  const caValidity = readValidity(caPem);
  const caExpiresAt = new Date(caValidity.notAfter).toISOString();
  const leaves = new LruCache<CachedLeaf>(MAX_CACHED_LEAVES);
  const preparations = new Map<string, Promise<CachedLeaf>>();
  let failedCertificates = 0;

  const assertCaValid = () => {
    if (!validAt(caValidity, Date.now())) {
      throw new SecretEgressCertificateError(CA_RESTART_MESSAGE);
    }
  };

  const getLeaf = (hostname: string): Promise<CachedLeaf> => {
    assertCaValid();
    const leaf = leaves.get(hostname);
    const now = Date.now();
    if (
      leaf &&
      validAt(leaf.validity, now) &&
      leaf.validity.notAfter - now > LEAF_RENEWAL_MARGIN_MS
    ) {
      return Promise.resolve(leaf);
    }
    let pending = preparations.get(hostname);
    if (!pending) {
      pending = generateLocalProxyLeaf({ certDir, ca, hostname })
        .then((material) => {
          assertCaValid();
          const validity = readValidity(material.cert);
          if (!validAt(validity, Date.now())) {
            throw new SecretEgressCertificateError(CERTIFICATE_RETRY_MESSAGE);
          }
          const issued = { ...material, validity };
          leaves.set(hostname, issued);
          return issued;
        })
        .finally(() => preparations.delete(hostname));
      preparations.set(hostname, pending);
    }
    return pending;
  };

  return {
    caCertPath: ca.certPath,
    caPem,
    getStatus: (): SecretEgressCertificateStatus => {
      const now = Date.now();
      const message = !validAt(caValidity, now)
        ? CA_RESTART_MESSAGE
        : failedCertificates > 0
          ? CERTIFICATE_RETRY_MESSAGE
          : caValidity.notAfter - now <= CA_WARNING_MARGIN_MS
            ? "Secret egress proxy CA expires within seven days. Restart the Gateway before expiry to create a new process trust chain."
            : undefined;
      return {
        state: message ? "degraded" : "ready",
        caExpiresAt,
        failedCertificates,
        ...(message ? { message } : {}),
      };
    },
    createContext: (params: {
      hostname: string;
      isActive: () => boolean;
      createServer: (leaf: { cert: Buffer; key: Buffer }) => SecretEgressTlsEndpoint;
    }): SecretEgressTlsContext => {
      let ready: { server: SecretEgressTlsEndpoint; leaf: CachedLeaf } | undefined;
      let failed = false;
      const setFailed = (value: boolean) => {
        failedCertificates += Number(value) - Number(failed);
        failed = value;
      };
      return {
        get: async () => {
          if (!params.isActive()) {
            return undefined;
          }
          try {
            const leaf = await getLeaf(params.hostname);
            // Certificate material belongs to the CA; endpoints and authority
            // still belong to this registration, including after shared issuance.
            if (!params.isActive()) {
              return undefined;
            }
            assertCaValid();
            if (!validAt(leaf.validity, Date.now())) {
              throw new SecretEgressCertificateError(CERTIFICATE_RETRY_MESSAGE);
            }
            if (ready) {
              if (ready.leaf !== leaf) {
                // Only new handshakes use the replacement; active TLS streams
                // and the registration-bound HTTP listener retain their owner.
                ready.server.setSecureContext(leaf);
                ready.leaf = leaf;
              }
            } else {
              ready = { server: params.createServer(leaf), leaf };
            }
            setFailed(false);
            return ready.server;
          } catch {
            if (!params.isActive()) {
              return undefined;
            }
            setFailed(true);
            // Never expose OpenSSL output, paths, or key material to clients.
            assertCaValid();
            throw new SecretEgressCertificateError(CERTIFICATE_RETRY_MESSAGE);
          }
        },
        close: () => {
          setFailed(false);
          ready?.server.close();
        },
      };
    },
    close: async () => {
      await Promise.allSettled(preparations.values());
      leaves.clear();
    },
  };
}
