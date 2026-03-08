import type { GatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { startGatewayBonjourAdvertiser } from "../infra/bonjour.js";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import { resolveWideAreaDiscoveryDomain, writeWideAreaGatewayZone } from "../infra/widearea-dns.js";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";

// Cache the Bonjour advertiser across in-process restarts so the mDNS service
// identity stays stable. Destroying and re-creating the service in quick
// succession races with the OS mDNS cache, causing name-conflict loops (#33609).
let cachedBonjour: GatewayBonjourAdvertiser | null = null;

export async function startGatewayDiscovery(params: {
  machineDisplayName: string;
  port: number;
  gatewayTls?: { enabled: boolean; fingerprintSha256?: string };
  canvasPort?: number;
  wideAreaDiscoveryEnabled: boolean;
  wideAreaDiscoveryDomain?: string | null;
  tailscaleMode: "off" | "serve" | "funnel";
  /** mDNS/Bonjour discovery mode (default: minimal). */
  mdnsMode?: "off" | "minimal" | "full";
  logDiscovery: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  let bonjourStop: (() => Promise<void>) | null = null;
  const mdnsMode = params.mdnsMode ?? "minimal";
  // mDNS can be disabled via config (mdnsMode: off) or env var.
  const bonjourEnabled =
    mdnsMode !== "off" &&
    process.env.OPENCLAW_DISABLE_BONJOUR !== "1" &&
    process.env.NODE_ENV !== "test" &&
    !process.env.VITEST;
  const mdnsMinimal = mdnsMode !== "full";
  const tailscaleEnabled = params.tailscaleMode !== "off";
  const needsTailnetDns = bonjourEnabled || params.wideAreaDiscoveryEnabled;
  const tailnetDns = needsTailnetDns
    ? await resolveTailnetDnsHint({ enabled: tailscaleEnabled })
    : undefined;
  const sshPortEnv = mdnsMinimal ? undefined : process.env.OPENCLAW_SSH_PORT?.trim();
  const sshPortParsed = sshPortEnv ? Number.parseInt(sshPortEnv, 10) : NaN;
  const sshPort = Number.isFinite(sshPortParsed) && sshPortParsed > 0 ? sshPortParsed : undefined;
  const cliPath = mdnsMinimal ? undefined : resolveBonjourCliPath();

  if (!bonjourEnabled && cachedBonjour) {
    cachedBonjour.stop().catch(() => {});
    cachedBonjour = null;
  }

  if (bonjourEnabled) {
    if (cachedBonjour) {
      // NOTE: Cached advertiser is reused verbatim to avoid mDNS name-conflict
      // loops on restart. Any change to port, TLS, displayName, or other mDNS
      // fields since the original start will NOT be reflected until a full
      // process restart (which recreates the advertiser).
      bonjourStop = cachedBonjour.stop;
    } else {
      try {
        const bonjour = await startGatewayBonjourAdvertiser({
          instanceName: formatBonjourInstanceName(params.machineDisplayName),
          gatewayPort: params.port,
          gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
          gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
          canvasPort: params.canvasPort,
          sshPort,
          tailnetDns,
          cliPath,
          minimal: mdnsMinimal,
        });
        cachedBonjour = bonjour;
        bonjourStop = () => {
          cachedBonjour = null;
          return bonjour.stop();
        };
      } catch (err) {
        params.logDiscovery.warn(`bonjour advertising failed: ${String(err)}`);
      }
    }
  }

  if (params.wideAreaDiscoveryEnabled) {
    const wideAreaDomain = resolveWideAreaDiscoveryDomain({
      configDomain: params.wideAreaDiscoveryDomain ?? undefined,
    });
    if (!wideAreaDomain) {
      params.logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no domain was configured; set discovery.wideArea.domain to enable unicast DNS-SD",
      );
      return { bonjourStop };
    }
    const tailnetIPv4 = pickPrimaryTailnetIPv4();
    if (!tailnetIPv4) {
      params.logDiscovery.warn(
        "discovery.wideArea.enabled is true, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
      );
    } else {
      try {
        const tailnetIPv6 = pickPrimaryTailnetIPv6();
        const result = await writeWideAreaGatewayZone({
          domain: wideAreaDomain,
          gatewayPort: params.port,
          displayName: formatBonjourInstanceName(params.machineDisplayName),
          tailnetIPv4,
          tailnetIPv6: tailnetIPv6 ?? undefined,
          gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
          gatewayTlsFingerprintSha256: params.gatewayTls?.fingerprintSha256,
          tailnetDns,
          sshPort,
          cliPath: resolveBonjourCliPath(),
        });
        params.logDiscovery.info(
          `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${wideAreaDomain} → ${result.zonePath})`,
        );
      } catch (err) {
        params.logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
      }
    }
  }

  return { bonjourStop };
}
