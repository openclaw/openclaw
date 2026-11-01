import path from "node:path";

export function createSecretEgressProxyEnvironment(proxyUrl: string, trustBundlePath: string) {
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
const SECRET_EGRESS_PROXY_ENV_KEYS: ReadonlySet<string> = new Set(
  Object.keys(createSecretEgressProxyEnvironment("", "")),
);

export function isSecretEgressProxyEnv(
  env: NodeJS.ProcessEnv,
  rawKey: string,
  platform = process.platform,
): boolean {
  const value = env[rawKey];
  const name = platform === "win32" ? rawKey.toUpperCase() : rawKey;
  if (!value || !SECRET_EGRESS_PROXY_ENV_KEYS.has(name)) {
    return false;
  }
  if (name === "NODE_USE_ENV_PROXY") {
    const proxies = Object.keys(env).filter((key) => /^https?_proxy$/iu.test(key) && env[key]);
    return (
      value === "1" &&
      proxies.length > 0 &&
      proxies.every((key) => isSecretEgressProxyEnv(env, key, platform))
    );
  }
  if (name.endsWith("_PROXY")) {
    return URL.canParse(value) && /^http:\/\/openclaw:[\w-]+@127\.0\.0\.1:\d+\/?$/u.test(value);
  }
  const resolved = (platform === "win32" ? path.win32 : path.posix).resolve(value);
  return /(?:^|[\\/])secret-egress-proxy[\\/]gateway-[^\\/]+[\\/].+/u.test(resolved);
}

export function omitSecretEgressProxyEnvironment(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !isSecretEgressProxyEnv(env, key, platform)),
  );
}
