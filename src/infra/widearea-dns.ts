import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { fnv1aUtf16 } from "../shared/fnv1a.js";
import { CONFIG_DIR } from "../utils.js";
import { ignoreMissingPath } from "./errno.js";

const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MAX_DNS_NAME_LENGTH = 253;
const INVALID_DOMAIN_ERROR = "wide-area discovery domain must be a valid DNS name";

function normalizedDomainLabels(raw: string): string[] {
  const trimmed = raw.trim();
  const withoutTrailingDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (!withoutTrailingDot || withoutTrailingDot.length > MAX_DNS_NAME_LENGTH) {
    throw new Error(INVALID_DOMAIN_ERROR);
  }

  const labels = withoutTrailingDot.split(".");
  if (labels.some((label) => !DNS_LABEL_RE.test(label))) {
    throw new Error(INVALID_DOMAIN_ERROR);
  }
  return labels;
}

export function normalizeWideAreaDomain(raw?: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const labels = normalizedDomainLabels(trimmed);
  return `${labels.join(".")}.`;
}

export function resolveWideAreaDiscoveryDomain(params?: {
  configDomain?: string | null;
}): string | null {
  const candidate = params?.configDomain ?? process.env.OPENCLAW_WIDE_AREA_DOMAIN ?? null;
  try {
    return normalizeWideAreaDomain(candidate);
  } catch {
    return null;
  }
}

export function getWideAreaZonePath(domain: string): string {
  const dnsDir = path.resolve(CONFIG_DIR, "dns");
  const zonePath = path.resolve(dnsDir, `${normalizedDomainLabels(domain).join(".")}.db`);
  const relativePath = path.relative(dnsDir, zonePath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("wide-area discovery zone path must stay under DNS config directory");
  }
  return zonePath;
}

/** Durably replace the CoreDNS zone only after its complete sibling write succeeds. */
export function replaceWideAreaZoneFile(zonePath: string, content: string): void {
  replaceFileAtomicSync({
    filePath: zonePath,
    content,
    dirMode: 0o700,
    mode: 0o644,
    preserveExistingMode: true,
    syncTempFile: true,
    syncParentDir: true,
    tempPrefix: ".openclaw-dns-zone",
  });
}

function dnsLabel(raw: string, fallback: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(raw)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  const out = normalized.length > 0 ? normalized : fallback;
  return out.length <= 63 ? out : out.slice(0, 63);
}

function txtQuote(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
  return `"${escaped}"`;
}

function extractContentHash(zoneText: string): string | null {
  const match = zoneText.match(/^\s*;\s*openclaw-content-hash:\s*(\S+)\s*$/m);
  return match?.[1] ?? null;
}

export type WideAreaGatewayZoneOpts = {
  domain: string;
  gatewayPort: number;
  displayName: string;
  tailnetIPv4: string;
  tailnetIPv6?: string;
  gatewayTlsEnabled?: boolean;
  gatewayTlsFingerprintSha256?: string;
  gatewayDirectReachable?: boolean;
  tailnetDns?: string;
  sshPort?: number;
  cliPath?: string;
};

export function renderWideAreaGatewayZoneText(
  opts: WideAreaGatewayZoneOpts & { serial: number },
): string {
  const hostname = os.hostname().split(".")[0] ?? "openclaw";
  const hostLabel = dnsLabel(hostname, "openclaw");
  const instanceLabel = dnsLabel(`${hostname}-gateway`, "openclaw-gw");
  const domain = normalizeWideAreaDomain(opts.domain) ?? "local.";

  const txt = [
    `displayName=${opts.displayName.trim() || hostname}`,
    `role=gateway`,
    `transport=gateway`,
    `gatewayPort=${opts.gatewayPort}`,
  ];
  if (opts.gatewayTlsEnabled) {
    txt.push(`gatewayTls=1`);
    if (opts.gatewayTlsFingerprintSha256) {
      txt.push(`gatewayTlsSha256=${opts.gatewayTlsFingerprintSha256}`);
    }
  }
  if (opts.gatewayDirectReachable) {
    txt.push(`gatewayDirectReachable=1`);
  }
  if (opts.tailnetDns?.trim()) {
    txt.push(`tailnetDns=${opts.tailnetDns.trim()}`);
  }
  if (typeof opts.sshPort === "number" && opts.sshPort > 0) {
    txt.push(`sshPort=${opts.sshPort}`);
  }
  if (opts.cliPath?.trim()) {
    txt.push(`cliPath=${opts.cliPath.trim()}`);
  }

  const soaLine = `@ IN SOA ns1 hostmaster ${opts.serial} 7200 3600 1209600 60`;
  const records = [
    `$ORIGIN ${domain}`,
    `$TTL 60`,
    soaLine,
    `@ IN NS ns1`,
    `ns1 IN A ${opts.tailnetIPv4}`,
    `${hostLabel} IN A ${opts.tailnetIPv4}`,
  ];
  if (opts.tailnetIPv6) {
    records.push(`${hostLabel} IN AAAA ${opts.tailnetIPv6}`);
  }

  records.push(`_openclaw-gw._tcp IN PTR ${instanceLabel}._openclaw-gw._tcp`);
  records.push(`${instanceLabel}._openclaw-gw._tcp IN SRV 0 0 ${opts.gatewayPort} ${hostLabel}`);
  records.push(`${instanceLabel}._openclaw-gw._tcp IN TXT ${txt.map(txtQuote).join(" ")}`);

  const contentBody = `${records.join("\n")}\n`;
  const hashBody = `${records
    .map((line) =>
      line === soaLine ? `@ IN SOA ns1 hostmaster SERIAL 7200 3600 1209600 60` : line,
    )
    .join("\n")}\n`;
  // Cheap stable hash; avoids importing crypto (and keeps deterministic across runtimes).
  const contentHash = fnv1aUtf16(hashBody).toString(16).padStart(8, "0");

  return `; openclaw-content-hash: ${contentHash}\n${contentBody}`;
}

export async function writeWideAreaGatewayZone(
  opts: WideAreaGatewayZoneOpts,
): Promise<{ zonePath: string; changed: boolean }> {
  const domain = normalizeWideAreaDomain(opts.domain);
  if (!domain) {
    throw new Error("wide-area discovery domain is required");
  }
  const normalizedOpts = { ...opts, domain };
  const zonePath = getWideAreaZonePath(domain);

  const existing = (() => {
    try {
      return fs.readFileSync(zonePath, "utf-8");
    } catch (error) {
      return ignoreMissingPath(error) ?? null;
    }
  })();

  const nextNoSerial = renderWideAreaGatewayZoneText({ ...normalizedOpts, serial: 0 });
  const nextHash = extractContentHash(nextNoSerial);
  const existingHash = existing ? extractContentHash(existing) : null;

  if (existing && nextHash && existingHash === nextHash) {
    return { zonePath, changed: false };
  }

  const serialMatch = existing?.match(/^\s*@\s+IN\s+SOA\s+\S+\s+\S+\s+(\d+)\s+/m);
  const parsedSerial = serialMatch
    ? Number.parseInt(expectDefined(serialMatch[1], "widearea dns regex capture 1"), 10)
    : Number.NaN;
  const existingSerial = Number.isFinite(parsedSerial) ? parsedSerial : null;
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const base = Number.parseInt(`${y}${m}${d}01`, 10);
  let serial = base;
  if (existingSerial !== null && Number.isFinite(existingSerial)) {
    // RFC 1982 accepts only advances smaller than half the unsigned serial space.
    const distance = (base - existingSerial) >>> 0;
    serial = distance > 0 && distance < 0x80000000 ? base : (existingSerial + 1) >>> 0;
  }
  const next = renderWideAreaGatewayZoneText({ ...normalizedOpts, serial });
  replaceWideAreaZoneFile(zonePath, next);
  return { zonePath, changed: true };
}
