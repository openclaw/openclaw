// Extension shared tests cover plugin-safe shared runtime helpers and proxy configuration.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAmbientNodeProxyAgentMock = vi.hoisted(() => vi.fn(() => ({ proxy: true })));
const hasAmbientNodeProxyConfiguredMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../infra/net/proxyline-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/proxyline-runtime.js")>()),
  loadProxyline: () => ({
    createAmbientNodeProxyAgent: createAmbientNodeProxyAgentMock,
    hasAmbientNodeProxyConfigured: hasAmbientNodeProxyConfiguredMock,
  }),
}));

import { resolveAmbientNodeProxyAgent } from "./extension-shared.js";

describe("resolveAmbientNodeProxyAgent", () => {
  const envKeys = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ] as const;
  const tempDirs: string[] = [];

  beforeEach(() => {
    createAmbientNodeProxyAgentMock.mockClear();
    hasAmbientNodeProxyConfiguredMock.mockClear();
    hasAmbientNodeProxyConfiguredMock.mockReturnValue(true);
    for (const key of envKeys) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  function writeTempCa(contents: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-shared-proxy-ca-"));
    tempDirs.push(dir);
    const caFile = path.join(dir, "proxy-ca.pem");
    writeFileSync(caFile, contents, "utf8");
    return caFile;
  }

  it("leaves agent creation and callbacks untouched without an ambient proxy", async () => {
    hasAmbientNodeProxyConfiguredMock.mockReturnValue(false);
    const onUsingProxy = vi.fn();
    const onError = vi.fn();

    await expect(resolveAmbientNodeProxyAgent({ onUsingProxy, onError })).resolves.toBeUndefined();
    expect(createAmbientNodeProxyAgentMock).not.toHaveBeenCalled();
    expect(onUsingProxy).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps selector failures outside the agent creation error handler", async () => {
    const failure = new Error("fixture selector failure");
    hasAmbientNodeProxyConfiguredMock.mockImplementationOnce(() => {
      throw failure;
    });
    const onError = vi.fn();

    await expect(resolveAmbientNodeProxyAgent({ onError })).rejects.toBe(failure);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports construction failures and returns no agent", async () => {
    const failure = new Error("fixture construction failure");
    createAmbientNodeProxyAgentMock.mockImplementationOnce(() => {
      throw failure;
    });
    const onError = vi.fn();

    await expect(resolveAmbientNodeProxyAgent({ onError })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("adds managed proxy CA trust to ambient Node proxy agents", async () => {
    const caFile = writeTempCa("extension-shared-managed-proxy-ca");
    vi.stubEnv("https_proxy", "https://proxy.example:8443");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);

    const agent = await resolveAmbientNodeProxyAgent<{ proxy: true }>();

    expect(agent).toEqual({ proxy: true });
    expect(createAmbientNodeProxyAgentMock).toHaveBeenCalledWith({
      protocol: "https",
      proxyTls: { ca: "extension-shared-managed-proxy-ca" },
    });
  });
});
