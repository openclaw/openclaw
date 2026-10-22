import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
  type ActiveManagedProxyRegistration,
} from "./active-proxy-state.js";
import {
  addActiveManagedProxyTlsOptions,
  resolveActiveManagedProxyTlsOptions,
} from "./managed-proxy-undici.js";

describe("managed proxy undici TLS options", () => {
  const managedProxy = "https://managed.example:8443";
  const otherProxy = "https://account-proxy.example:8443";
  const tempDirs: string[] = [];
  const activeRegistrations: ActiveManagedProxyRegistration[] = [];

  beforeEach(() => {
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", "");
  });

  afterEach(() => {
    for (const registration of activeRegistrations.splice(0)) {
      stopActiveManagedProxyRegistration(registration);
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it("adds active proxy CA trust only to matching explicit proxy URLs", () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    activeRegistrations.push(
      registerActiveManagedProxyUrl(new URL(managedProxy), {
        loopbackMode: "gateway-only",
        proxyTls: { ca: "active-managed-ca" },
      }),
    );

    expect(addActiveManagedProxyTlsOptions({ uri: managedProxy, allowH2: false })).toStrictEqual({
      uri: managedProxy,
      allowH2: false,
      proxyTls: { ca: "active-managed-ca" },
    });
    expect(addActiveManagedProxyTlsOptions({ uri: otherProxy, allowH2: false })).toStrictEqual({
      uri: otherProxy,
      allowH2: false,
    });
  });

  it("loads inherited proxy CA trust only for the inherited proxy URL", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-proxy-ca-"));
    tempDirs.push(dir);
    const caFile = path.join(dir, "proxy-ca.pem");
    writeFileSync(caFile, "inherited-managed-ca", "utf8");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("https_proxy", managedProxy);
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);

    expect(resolveActiveManagedProxyTlsOptions()).toStrictEqual({ ca: "inherited-managed-ca" });
    expect(resolveActiveManagedProxyTlsOptions({ proxyUrl: managedProxy })).toStrictEqual({
      ca: "inherited-managed-ca",
    });
    expect(resolveActiveManagedProxyTlsOptions({ proxyUrl: otherProxy })).toBeUndefined();
  });
});
