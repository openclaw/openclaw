/** Runtime-aligned trusted-proxy readiness checks used by doctor security diagnostics. */
import { validateHeaderName, validateHeaderValue } from "node:http";
import { normalizeIpAddress, parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/config.js";
import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  resolveGatewayPortWithDefault,
} from "../config/gateway-control-ui-origins.js";
import { canMaterializeGatewayAuthSecretRefsWithoutExec } from "../gateway/auth-config-utils.js";
import {
  assertGatewayAuthConfigured,
  authorizeHttpGatewayConnect,
  resolveGatewayAuth,
} from "../gateway/auth.js";
import { isContainerEnvironment, isTrustedProxyAddress } from "../gateway/net.js";
import { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";

/**
 * Mirrors gateway startup: seed runtime-only Control UI origins first, then run the real
 * runtime resolver. Skipping the seeding step would report startup failures for configs the
 * Gateway actually accepts. Exec-backed refs remain explicitly unverified unless the operator
 * allows their provider to run.
 */
export async function resolveGatewayStartupValidation(
  cfg: OpenClawConfig,
  options: { allowExecSecretRefs?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<
  | { status: "ready" }
  | { status: "invalid"; problem: string }
  | { status: "unverified"; problem: string }
> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(cfg, { isContainerEnvironment });
  // Startup lazy-loads this resolver; keep the doctor on the same dynamic boundary.
  const { resolveGatewayRuntimeConfig } = await import("../gateway/server-runtime-config.js");
  const env = options.env ?? process.env;
  const canPreflightAuthSecretRefs =
    options.allowExecSecretRefs === true ||
    canMaterializeGatewayAuthSecretRefsWithoutExec({
      cfg: seeded.config,
      env,
      mode: seeded.config.gateway?.auth?.mode,
      hasTokenCandidate: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN)),
      hasPasswordCandidate: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD)),
    });
  try {
    // Same order as gateway startup: the auth secret preflight throws on unresolvable
    // active refs (trusted-proxy treats password refs as active) before the resolver runs.
    if (canPreflightAuthSecretRefs) {
      await ensureGatewayStartupAuth({ cfg: seeded.config, env, warn: () => {} });
    }
    await resolveGatewayRuntimeConfig({
      cfg: seeded.config,
      port: resolveGatewayPortWithDefault(cfg.gateway?.port),
    });
    if (!canPreflightAuthSecretRefs) {
      return {
        status: "unverified",
        problem:
          "Gateway startup auth readiness could not be verified because an active exec SecretRef was skipped.",
      };
    }
    return { status: "ready" };
  } catch (error) {
    return {
      status: "invalid",
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

type TrustedProxySource = {
  entry: string;
  address: string;
};

type TrustedProxyReadiness = {
  problems: string[];
};

// ipaddr.js range classes that can never originate a proxy TCP connection.
const UNUSABLE_PROXY_SOURCE_RANGES = new Set(["unspecified", "broadcast", "multicast"]);

function parseHostScopedTrustedProxySource(entry: string): TrustedProxySource | undefined {
  const parts = entry.split("/");
  if (parts.length > 2) {
    return undefined;
  }
  const rawAddress = parts[0]?.trim() ?? "";
  const parsedAddress = parseCanonicalIpAddress(rawAddress);
  if (!parsedAddress) {
    return undefined;
  }
  const rawBits = parsedAddress.kind() === "ipv6" ? 128 : 32;
  const rawPrefix = parts.length === 1 ? rawBits : Number(parts[1]?.trim());
  // Doctor only downgrades host-scoped proxy identities. The public setup
  // checklist requires actual proxy IPs, not subnets, because every address in
  // a trusted CIDR can forge the configured identity headers.
  if (!Number.isInteger(rawPrefix) || rawPrefix !== rawBits) {
    return undefined;
  }
  // normalizeIpAddress folds IPv4-mapped IPv6 into IPv4 text, matching runtime isIpInCidr.
  const address = normalizeIpAddress(rawAddress);
  const normalizedAddress = parseCanonicalIpAddress(address);
  if (!address || !normalizedAddress) {
    return undefined;
  }
  if (UNUSABLE_PROXY_SOURCE_RANGES.has(normalizedAddress.range())) {
    return undefined;
  }
  return isTrustedProxyAddress(address, [entry]) ? { entry, address } : undefined;
}

type ProxySourceProbe = { ok: true } | { ok: false; reason: string };

async function probeProxySource(
  source: TrustedProxySource,
  auth: ReturnType<typeof resolveGatewayAuth>,
): Promise<ProxySourceProbe> {
  const trustedProxy = auth.trustedProxy;
  if (!trustedProxy) {
    return { ok: false, reason: "trusted_proxy_config_missing" };
  }
  const allowUsers = trustedProxy.allowUsers ?? [];
  const userHeader = normalizeLowercaseStringOrEmpty(trustedProxy.userHeader);
  // Runtime trims the presented identity before comparing it with allowUsers,
  // so only an already-normalized entry can satisfy a non-empty allowlist.
  const user =
    allowUsers.length === 0
      ? "doctor-probe"
      : allowUsers.find((entry) => {
          if (normalizeOptionalString(entry) !== entry) {
            return false;
          }
          try {
            validateHeaderValue(userHeader, entry);
            return true;
          } catch {
            return false;
          }
        });
  if (!user) {
    return { ok: false, reason: "trusted_proxy_no_deliverable_allow_user" };
  }
  const headers: Record<string, string> = {};
  for (const header of trustedProxy.requiredHeaders ?? []) {
    headers[normalizeLowercaseStringOrEmpty(header)] = "present";
  }
  headers[userHeader] = user;

  const result = await authorizeHttpGatewayConnect({
    auth,
    connectAuth: null,
    trustedProxies: [source.entry],
    req: { socket: { remoteAddress: source.address }, headers } as never,
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "unauthorized" };
}

export async function resolveTrustedProxyReadiness(params: {
  cfg: OpenClawConfig;
  auth: ReturnType<typeof resolveGatewayAuth>;
}): Promise<TrustedProxyReadiness> {
  const problems: string[] = [];
  try {
    assertGatewayAuthConfigured(params.auth, params.cfg.gateway?.auth);
  } catch (error) {
    problems.push(
      error instanceof Error ? error.message : "Gateway rejected the trusted-proxy config.",
    );
  }
  const trustedProxy = params.auth.trustedProxy;
  if (!trustedProxy) {
    if (problems.length === 0) {
      problems.push("Gateway rejected the trusted-proxy config.");
    }
  } else {
    for (const [path, header] of [
      ["gateway.auth.trustedProxy.userHeader", trustedProxy.userHeader],
      ...(trustedProxy.requiredHeaders ?? []).map(
        (entry, index) => [`gateway.auth.trustedProxy.requiredHeaders[${index}]`, entry] as const,
      ),
    ] as const) {
      const normalizedHeader = normalizeLowercaseStringOrEmpty(header);
      // The runtime assertion above owns the empty userHeader diagnostic.
      if (path === "gateway.auth.trustedProxy.userHeader" && normalizedHeader === "") {
        continue;
      }
      if (normalizedHeader === "__proto__") {
        problems.push(
          `${path} is not a deliverable HTTP header name, so a proxy cannot supply it.`,
        );
        continue;
      }
      try {
        validateHeaderName(normalizedHeader);
      } catch {
        problems.push(`${path} is not a valid HTTP header name, so a proxy cannot supply it.`);
      }
    }
  }
  const trustedProxies = (params.cfg.gateway?.trustedProxies ?? [])
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => entry !== undefined);
  if (trustedProxies.length === 0) {
    problems.push(
      "gateway.trustedProxies is empty, so every trusted-proxy request will be rejected.",
    );
  }
  const sources = trustedProxies.map(parseHostScopedTrustedProxySource);
  if (sources.some((source) => source === undefined)) {
    problems.push(
      "gateway.trustedProxies includes an invalid or unusable source, or a non-host-scoped CIDR; use canonical usable unicast proxy IPs (exact, /32, or /128).",
    );
  }
  // Runtime authorization assumes all static prerequisites above are valid. Preserve every static
  // diagnostic, then avoid probing with malformed headers or mutually exclusive auth settings.
  if (problems.length > 0) {
    return { problems };
  }
  // Surface the runtime rejection codes so operators can see why each source failed
  // (e.g. trusted_proxy_local_interface_source) instead of guessing.
  const failureReasons = new Set<string>();
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const probe = await probeProxySource(source, params.auth);
    if (probe.ok) {
      return { problems: [] };
    }
    failureReasons.add(probe.reason);
  }
  return {
    problems: [
      `No configured proxy source can pass the Gateway's source checks in this runtime environment (runtime reasons: ${[...failureReasons].join(", ")}).`,
    ],
  };
}
