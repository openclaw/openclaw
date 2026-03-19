import { normalizeIpAddress } from "../shared/net/ip.js";
import { isTrustedProxyAddress } from "./net.js";

export interface ForwardedHeader {
  for?: string;
  by?: string;
  host?: string;
  proto?: string;
}

export interface ParsedForwardedChain {
  entries: ForwardedHeader[];
  clientIp?: string;
  originalHost?: string;
  originalProto?: string;
}

const MAX_PROXY_CHAIN_DEPTH = 10;

export function parseForwardedHeader(header: string | string[] | undefined): ForwardedHeader[] {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw || typeof raw !== "string") {
    return [];
  }

  const entries: ForwardedHeader[] = [];
  const segments = raw.split(/\s*,\s*/);

  for (const segment of segments) {
    const entry: ForwardedHeader = {};
    const fields = segment.split(/\s*;\s*/);

    for (const field of fields) {
      const match = field.match(/^([a-z]+)=(?:"([^"]+)"|([^;]+))?$/i);
      if (match) {
        const key = match[1].toLowerCase();
        const value = match[2] ?? match[3];

        if (key === "for" || key === "by" || key === "host" || key === "proto") {
          entry[key] = value?.trim();
        }
      }
    }

    if (Object.keys(entry).length > 0) {
      entries.push(entry);
    }
  }

  return entries.slice(0, MAX_PROXY_CHAIN_DEPTH);
}

export function parseForwardedChain(params: {
  forwardedHeader?: string | string[];
  xForwardedFor?: string | string[];
  xForwardedHost?: string | string[];
  xForwardedProto?: string | string[];
  trustedProxies?: string[];
}): ParsedForwardedChain {
  const { trustedProxies = [] } = params;
  const forwardedEntries = parseForwardedHeader(params.forwardedHeader);

  let clientIp: string | undefined;
  let originalHost: string | undefined;
  let originalProto: string | undefined;

  if (forwardedEntries.length > 0) {
    for (let i = forwardedEntries.length - 1; i >= 0; i -= 1) {
      const entry = forwardedEntries[i];
      const forIp = extractIpFromForwardedFor(entry.for);

      if (forIp && !isTrustedProxy(forIp, trustedProxies)) {
        clientIp = forIp;
        break;
      }
    }

    const firstEntry = forwardedEntries[0];
    if (firstEntry) {
      originalHost = firstEntry.host;
      originalProto = firstEntry.proto;
    }
  }

  if (!originalHost && params.xForwardedHost) {
    const raw = Array.isArray(params.xForwardedHost)
      ? params.xForwardedHost[0]
      : params.xForwardedHost;
    if (raw) {
      const parts = raw.split(",");
      originalHost = parts[0]?.trim();
    }
  }

  if (!originalProto && params.xForwardedProto) {
    const raw = Array.isArray(params.xForwardedProto)
      ? params.xForwardedProto[0]
      : params.xForwardedProto;
    if (raw) {
      originalProto = raw.trim().toLowerCase();
    }
  }

  if (!clientIp && params.xForwardedFor && trustedProxies.length > 0) {
    const raw = Array.isArray(params.xForwardedFor)
      ? params.xForwardedFor.join(",")
      : params.xForwardedFor;

    const chain: string[] = [];
    for (const entry of raw.split(",")) {
      const normalized = extractIpFromForwardedFor(entry);
      if (normalized) {
        chain.push(normalized);
      }
    }

    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const ip = chain[i];
      if (ip && !isTrustedProxy(ip, trustedProxies)) {
        clientIp = ip;
        break;
      }
    }
  }

  return {
    entries: forwardedEntries,
    clientIp,
    originalHost,
    originalProto,
  };
}

function extractIpFromForwardedFor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  let cleaned = value.trim();

  if (cleaned.startsWith("[")) {
    const endBracket = cleaned.indexOf("]");
    if (endBracket > 0) {
      cleaned = cleaned.slice(1, endBracket);
    }
  }

  const colonIndex = cleaned.lastIndexOf(":");
  if (colonIndex > 0 && !cleaned.slice(colonIndex + 1).includes(":")) {
    const portPart = cleaned.slice(colonIndex + 1);
    if (/^\d+$/.test(portPart)) {
      cleaned = cleaned.slice(0, colonIndex);
    }
  }

  return normalizeIpAddress(cleaned);
}

function isTrustedProxy(ip: string, trustedProxies: string[]): boolean {
  return isTrustedProxyAddress(ip, trustedProxies);
}

export function validateProtoMismatch(params: {
  originProto: string;
  forwardedProto?: string;
  xForwardedProto?: string | string[];
}): { ok: true } | { ok: false; reason: string } {
  const { originProto, forwardedProto, xForwardedProto } = params;

  const originNormalized = originProto.toLowerCase();

  if (forwardedProto) {
    const forwardedNormalized = forwardedProto.toLowerCase();
    if (originNormalized !== forwardedNormalized) {
      return {
        ok: false,
        reason: `origin protocol (${originProto}) does not match Forwarded proto (${forwardedProto})`,
      };
    }
  }

  if (xForwardedProto) {
    const raw = Array.isArray(xForwardedProto) ? xForwardedProto[0] : xForwardedProto;
    if (raw) {
      const xNormalized = raw.trim().toLowerCase();
      if (originNormalized !== xNormalized) {
        return {
          ok: false,
          reason: `origin protocol (${originProto}) does not match X-Forwarded-Proto (${raw})`,
        };
      }
    }
  }

  return { ok: true };
}
