// This receipt is process-local provenance, never service configuration or authority.
const INJECTED_ENV = "OPENCLAW_SECRET_EGRESS_PROXY_ENV";

function proxyEnvironment(proxyUrl: string, trustBundlePath: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: trustBundlePath,
    SSL_CERT_FILE: trustBundlePath,
    CURL_CA_BUNDLE: trustBundlePath,
    REQUESTS_CA_BUNDLE: trustBundlePath,
    GIT_SSL_CAINFO: trustBundlePath,
  };
}

export function createSecretEgressProxyEnvironment(
  proxyUrl: string,
  trustBundlePath: string,
): Record<string, string> {
  const env = proxyEnvironment(proxyUrl, trustBundlePath);
  return { ...env, [INJECTED_ENV]: JSON.stringify(env) };
}

/** Identify only unchanged injected values; later operator overrides remain durable. */
export function secretEgressProxyEnvironmentKeys(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const normalize = (key: string) => (platform === "win32" ? key.toUpperCase() : key);
  const entries = Object.entries(env);
  const normalized = Object.fromEntries(entries.map(([key, value]) => [normalize(key), value]));
  let recorded: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(normalized[INJECTED_ENV] ?? "null");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      recorded = Object.fromEntries(Object.entries(value));
    }
  } catch {
    // Pre-receipt services can still be recognized by their reserved CA directory.
  }
  const caPath = normalized.NODE_EXTRA_CA_CERTS;
  const legacyCa = (value: string | undefined) =>
    Boolean(
      value &&
      /(?:^|[\\/])secret-egress-proxy[\\/]gateway-[^\\/]+[\\/]trust-bundle\.pem$/u.test(
        value.trim(),
      ),
    );
  const proxyUrl = normalized.HTTPS_PROXY;
  const legacyProxy =
    legacyCa(caPath) && /^http:\/\/openclaw:[^@]+@127\.0\.0\.1:\d+$/u.test(proxyUrl ?? "")
      ? proxyUrl!
      : "";
  const legacy = proxyEnvironment(legacyProxy, caPath ?? "");
  return entries.flatMap(([key, value]) => {
    const name = normalize(key);
    if (name === INJECTED_ENV) {
      return [key];
    }
    if (recorded) {
      return typeof value === "string" && recorded[name] === value ? [key] : [];
    }
    // Legacy units have no receipt. Match only owner-defined keys and reserved
    // paths (or the matching authenticated loopback proxy), never arbitrary CAs.
    if (!Object.hasOwn(legacy, name) || !value) {
      return [];
    }
    return legacyCa(value) ||
      (legacyCa(caPath) &&
        value === legacy[name] &&
        (name === "NODE_USE_ENV_PROXY" || Boolean(legacyProxy)))
      ? [key]
      : [];
  });
}

export function omitSecretEgressProxyEnvironment(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  options: { preserveProvenance?: boolean } = {},
): Record<string, string | undefined> {
  const omitted = new Set(secretEgressProxyEnvironmentKeys(env, platform));
  // Install/repair composition still needs this fact until its final snapshot.
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !omitted.has(key) || (options.preserveProvenance && key.toUpperCase() === INJECTED_ENV),
    ),
  );
}
