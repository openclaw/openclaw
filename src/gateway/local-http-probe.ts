import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { TLSSocket } from "node:tls";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const GATEWAY_HTTP_PROBE_MAX_RESPONSE_CHARS = 1024;

export type GatewayHttpProbeResponse = {
  statusCode: number;
  body: string;
  tlsFingerprint?: string;
};

type GatewayLocalProbeTarget = {
  url: string;
  tlsFingerprint?: string;
};

export type ConfiguredGatewayLocalProbe = {
  requestHttp(params: {
    host: string;
    pathname: "/healthz" | "/readyz";
    port: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<GatewayHttpProbeResponse | null>;
  resolveWebSocketTarget(
    port: number,
    signal?: AbortSignal,
  ): Promise<GatewayLocalProbeTarget | null>;
};

export function normalizeGatewayHttpProbeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export async function requestGatewayLocalHttpProbe(params: {
  host: string;
  pathname: "/healthz" | "/readyz";
  port: number;
  timeoutMs: number;
  tlsFingerprints?: readonly string[];
  signal?: AbortSignal;
}): Promise<GatewayHttpProbeResponse | null> {
  params.signal?.throwIfAborted();
  if (params.timeoutMs <= 0) {
    return null;
  }
  const response = await new Promise<GatewayHttpProbeResponse | null>((resolve) => {
    let settled = false;
    const finish = (result: GatewayHttpProbeResponse | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const pins = params.tlsFingerprints?.map(normalizeTlsFingerprint);
    const request = pins ? httpsRequest : httpRequest;
    const req = request(
      {
        hostname: normalizeGatewayHttpProbeHost(params.host),
        port: params.port,
        path: params.pathname,
        method: "GET",
        timeout: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        // Self-signed local Gateway certificates are trusted only by the exact
        // configured pin below; never accept them on ordinary HTTPS requests.
        // A reused socket still carries its old certificate after listener renewal.
        ...(pins ? { rejectUnauthorized: false, agent: false } : {}),
      },
      (res) => {
        let tlsFingerprint: string | undefined;
        if (pins) {
          tlsFingerprint =
            res.socket instanceof TLSSocket
              ? normalizeTlsFingerprint(res.socket.getPeerCertificate().fingerprint256 ?? "")
              : "";
          if (!tlsFingerprint || !pins.includes(tlsFingerprint)) {
            res.resume();
            finish(null);
            return;
          }
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length + chunk.length > GATEWAY_HTTP_PROBE_MAX_RESPONSE_CHARS) {
            res.destroy();
            finish(null);
            return;
          }
          body += chunk;
        });
        res.once("end", () => {
          finish({
            statusCode: res.statusCode ?? 0,
            body,
            ...(tlsFingerprint ? { tlsFingerprint } : {}),
          });
        });
        res.once("error", () => {
          finish(null);
        });
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      finish(null);
    }, params.timeoutMs);
    req.once("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.once("error", () => {
      finish(null);
    });
    req.end();
  });
  params.signal?.throwIfAborted();
  return response;
}

export function createConfiguredGatewayLocalProbe(
  config: OpenClawConfig,
): ConfiguredGatewayLocalProbe {
  const tlsConfig = config.gateway?.tls;
  type CertificatePin = { fingerprint: string; generation: number };
  let configured: CertificatePin | undefined;
  let inspection: Promise<CertificatePin | undefined> | undefined;
  let verified: (CertificatePin & { endpoint: string }) | undefined;
  // Share pending reads so file observations establish one ordered generation stream.
  const inspectCertificate = () =>
    (inspection ??= import("../infra/tls/gateway.js")
      .then(async ({ inspectGatewayTlsCertificate }) => {
        const certificate = await inspectGatewayTlsCertificate(tlsConfig);
        if (!certificate.ok) {
          return undefined;
        }
        const fingerprint = certificate.value.fingerprintSha256;
        if (configured?.fingerprint !== fingerprint) {
          configured = { fingerprint, generation: (configured?.generation ?? 0) + 1 };
        }
        return configured;
      })
      .catch(() => undefined)
      .finally(() => {
        inspection = undefined;
      }));
  const requestHttp: ConfiguredGatewayLocalProbe["requestHttp"] = async (params) => {
    params.signal?.throwIfAborted();
    const endpoint = `${normalizeGatewayHttpProbeHost(params.host)}:${params.port}`;
    const previous = verified;
    let candidate: CertificatePin | undefined;
    let tlsFingerprints: string[] | undefined;
    if (tlsConfig?.enabled === true) {
      candidate = await inspectCertificate();
      params.signal?.throwIfAborted();
      // Files may precede listener acceptance. Retain only this endpoint's last
      // verified serving pin while a replacement is incomplete or reload is off.
      tlsFingerprints = [
        ...(candidate ? [candidate.fingerprint] : []),
        ...(previous?.endpoint === endpoint ? [previous.fingerprint] : []),
      ];
      if (tlsFingerprints.length === 0) {
        return null;
      }
    }
    const result = await requestGatewayLocalHttpProbe({ ...params, tlsFingerprints });
    const accepted = result?.tlsFingerprint === candidate?.fingerprint ? candidate : previous;
    // Order by certificate observation, not response completion: parallel readiness
    // probes may finish an old handshake before or after verifying its replacement.
    if (
      result?.tlsFingerprint &&
      accepted &&
      (verified?.endpoint !== endpoint || accepted.generation >= verified.generation)
    ) {
      verified = { ...accepted, endpoint };
    }
    return result;
  };
  return {
    requestHttp,
    async resolveWebSocketTarget(port, signal) {
      signal?.throwIfAborted();
      if (tlsConfig?.enabled !== true) {
        return { url: `ws://127.0.0.1:${port}` };
      }
      const response = await requestHttp({
        host: "127.0.0.1",
        port,
        pathname: "/healthz",
        timeoutMs: 3_000,
        signal,
      });
      return response?.tlsFingerprint
        ? { url: `wss://127.0.0.1:${port}`, tlsFingerprint: response.tlsFingerprint }
        : null;
    },
  };
}
