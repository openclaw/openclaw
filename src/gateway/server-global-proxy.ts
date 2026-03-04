import * as dns from "node:dns";
import { readFileSync } from "node:fs";
import * as net from "node:net";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import type { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/global-proxy");

let applied = false;

/**
 * Collect the first proxy URL found in enabled channel configurations.
 *
 * When a proxy is configured for any enabled channel (e.g. `channels.telegram.proxy`
 * or `channels.discord.proxy`), the gateway process itself — and any
 * third-party library that relies on `globalThis.fetch` — must also go
 * through that proxy.  Node's built-in `fetch` does not honor `HTTP_PROXY` /
 * `HTTPS_PROXY` env vars, so we need to install a proxy-aware undici
 * dispatcher globally.
 *
 * Channels with `enabled: false` are skipped so a stale/unreachable proxy
 * from a disabled channel does not affect unrelated outbound requests.
 */
function resolveFirstChannelProxy(cfg: ReturnType<typeof loadConfig>): string | undefined {
  const telegram = cfg.channels?.telegram;
  // Skip disabled channels (enabled defaults to true when not set)
  if (telegram && telegram.enabled !== false) {
    const telegramProxy = telegram.proxy?.trim();
    if (telegramProxy) {
      return telegramProxy;
    }

    // Check per-account proxy settings
    const telegramAccounts = telegram.accounts;
    if (telegramAccounts) {
      for (const acct of Object.values(telegramAccounts)) {
        const account = acct as { enabled?: boolean; proxy?: string };
        if (account.enabled !== false) {
          const p = account.proxy?.trim();
          if (p) {
            return p;
          }
        }
      }
    }
  }

  const discord = cfg.channels?.discord;
  if (discord && discord.enabled !== false) {
    const discordProxy = discord.proxy?.trim();
    if (discordProxy) {
      return discordProxy;
    }

    // Check per-account proxy settings
    const discordAccounts = discord.accounts;
    if (discordAccounts) {
      for (const acct of Object.values(discordAccounts)) {
        const account = acct as { enabled?: boolean; proxy?: string };
        if (account.enabled !== false) {
          const p = account.proxy?.trim();
          if (p) {
            return p;
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Install a global undici `ProxyAgent` so that **all** `globalThis.fetch`
 * calls inside the gateway process (including third-party libraries like
 * `@buape/carbon`) route through the configured proxy.
 *
 * This also applies the same WSL2-friendly IPv4 workarounds that the
 * Telegram channel applies (`autoSelectFamily=false`, `dnsResultOrder=ipv4first`).
 *
 * Must be called **once**, before any channels start.
 */
export function applyGlobalProxyDispatcher(cfg: ReturnType<typeof loadConfig>): void {
  if (applied) {
    return;
  }

  const proxyUrl = resolveFirstChannelProxy(cfg);
  if (!proxyUrl) {
    return;
  }

  try {
    // Apply WSL2-friendly network defaults first (same as Telegram workaround).
    // On WSL2, Node 22's default autoSelectFamily=true + broken IPv6 causes
    // 10-second connect timeouts.  Force IPv4 to avoid this.
    const isWsl2 =
      (process.platform === "linux" && /microsoft/i.test(process.env.WSL_DISTRO_NAME ?? "")) ||
      /microsoft.*wsl/i.test(
        (() => {
          try {
            return readFileSync("/proc/sys/kernel/osrelease", "utf8");
          } catch {
            return "";
          }
        })(),
      );

    if (isWsl2 && typeof net.setDefaultAutoSelectFamily === "function") {
      try {
        net.setDefaultAutoSelectFamily(false);
      } catch {
        // ignore
      }
    }

    if (isWsl2 && typeof dns.setDefaultResultOrder === "function") {
      try {
        dns.setDefaultResultOrder("ipv4first");
      } catch {
        // ignore
      }
    }

    setGlobalDispatcher(
      new ProxyAgent({
        uri: proxyUrl,
        ...(isWsl2 ? { connect: { autoSelectFamily: false } } : {}),
      }),
    );
    applied = true;
    // Redact credentials from the URL before logging (proxy URLs may contain user:password).
    const safeUrl = (() => {
      try {
        const u = new URL(proxyUrl);
        if (u.password) {
          u.password = "***";
        }
        if (u.username) {
          u.username = "***";
        }
        return u.toString();
      } catch {
        return proxyUrl;
      }
    })();
    log.info(`global proxy dispatcher set: ${safeUrl}${isWsl2 ? " (wsl2 ipv4-only)" : ""}`);
  } catch (err) {
    log.error(`failed to set global proxy dispatcher: ${String(err)}`);
  }
}

/** Whether the global proxy dispatcher was applied. */
export function isGlobalProxyDispatcherApplied(): boolean {
  return applied;
}

/** Reset for tests. */
export function resetGlobalProxyDispatcherForTests(): void {
  applied = false;
}
