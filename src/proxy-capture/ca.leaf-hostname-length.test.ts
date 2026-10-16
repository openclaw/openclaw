// Regression test: leaf cert generation must not depend on the X.509 CommonName length limit.
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "./ca.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("generateLocalProxyLeaf", () => {
  it("mints a valid leaf certificate for a hostname longer than 64 characters", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-leaf-");
    const ca = await ensureSecretEgressProxyCa(certDir);
    // Mirrors the object-storage endpoint shape from #152529: <bucket>.<account-id>.<provider-domain>.
    const hostname = `${"a".repeat(40)}.${"b".repeat(32)}.example.com`;
    expect(hostname.length).toBeGreaterThan(64);

    const leaf = await generateLocalProxyLeaf({ certDir, ca, hostname });

    const cert = new X509Certificate(leaf.cert);
    expect(cert.checkHost(hostname)).toBe(hostname);
  });
});
