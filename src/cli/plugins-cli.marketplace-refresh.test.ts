// Covers the hosted OpenClaw marketplace feed refresh command.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { createHostedMarketplaceFeedFixture } from "./plugins-marketplace-feed.test-support.js";

const mocks = vi.hoisted(() => {
  const defaultRuntime = {
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn(),
  };
  return {
    clearManagedPluginCatalogCache: vi.fn(),
    defaultRuntime,
    getRuntimeConfig: vi.fn(),
    loadConfiguredHostedOfficialExternalPluginCatalogEntries: vi.fn(),
    pluginLifecycleGateway: vi.fn(),
    resolvePluginLifecycleGateway: vi.fn(),
  };
});

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../plugins/official-external-plugin-catalog.js", () => ({
  loadConfiguredHostedOfficialExternalPluginCatalogEntries:
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries,
}));

vi.mock("../plugins/management-catalog.js", () => ({
  clearManagedPluginCatalogCache: mocks.clearManagedPluginCatalogCache,
}));

vi.mock("./plugins-lifecycle-client.js", () => ({
  resolvePluginLifecycleGateway: mocks.resolvePluginLifecycleGateway,
}));

async function createTimelinePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-marketplace-refresh-"));
  return path.join(dir, "timeline.jsonl");
}

async function readTimeline(pathname: string): Promise<Record<string, unknown>[]> {
  flushDiagnosticsTimeline();
  const content = await readFile(pathname, "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("plugins marketplace refresh", () => {
  beforeEach(() => {
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.getRuntimeConfig.mockReset();
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockReset();
    mocks.clearManagedPluginCatalogCache.mockReset();
    mocks.resolvePluginLifecycleGateway.mockReset().mockResolvedValue(mocks.pluginLifecycleGateway);
    mocks.pluginLifecycleGateway.mockReset().mockResolvedValue({ runtime: { generation: 4 } });
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    flushDiagnosticsTimeline();
    vi.unstubAllEnvs();
  });

  it("refreshes an explicitly selected marketplace feed and prints JSON", async () => {
    const config = {};
    mocks.getRuntimeConfig.mockReturnValue(config);
    const result = createHostedMarketplaceFeedFixture({
      entries: [{ name: "@acme/calendar" }, { name: "@acme/docs" }],
      etag: '"abc"',
    });
    Object.freeze(result.metadata);
    Object.freeze(result);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(result);
    mocks.pluginLifecycleGateway.mockResolvedValue({
      runtime: { generation: 4 },
      warnings: ["Previous plugin service could not stop."],
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "feed-sha",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith({
      feedProfile: "acme",
      expectedSha256: "feed-sha",
      requireSnapshotWrite: true,
    });
    expect(mocks.pluginLifecycleGateway).toHaveBeenCalledWith("plugins.refresh", {});
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
      source: "hosted",
      entries: 2,
      feed: {
        id: "acme-marketplace",
        generatedAt: "2026-06-23T00:00:00.000Z",
        sequence: 7,
      },
      metadata: {
        url: "https://packages.acme.example/openclaw/feed",
        status: 200,
        checksum: "feed-sha",
        etag: '"abc"',
      },
      trust: {
        mode: "signed",
        signedBy: "acme-root-2026",
        signatureCount: 1,
        threshold: 1,
        verifiedAt: "2026-06-23T00:01:02.000Z",
      },
    });
    const payload = mocks.defaultRuntime.writeJson.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).toBe(
      '{"source":"hosted","entries":2,"metadata":{"url":"https://packages.acme.example/openclaw/feed","status":200,"checksum":"feed-sha","etag":"\\"abc\\""},"feed":{"id":"acme-marketplace","generatedAt":"2026-06-23T00:00:00.000Z","sequence":7},"trust":{"mode":"signed","signedBy":"acme-root-2026","signatureCount":1,"threshold":1,"verifiedAt":"2026-06-23T00:01:02.000Z"}}',
    );
    expect(Object.keys(payload)).toEqual(["source", "entries", "metadata", "feed", "trust"]);
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Previous plugin service could not stop."),
    );
  });

  it("prints bounded signed feed trust state in text output", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture({ entries: [{ name: "@acme/calendar" }] }),
    );
    mocks.pluginLifecycleGateway.mockResolvedValue({
      runtime: { generation: 4 },
      warnings: ["Previous plugin service could not stop."],
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({});

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("Previous plugin service could not stop.");
    expect(output).toContain("Marketplace catalog applied in Gateway generation 4.");
    expect(output).toContain("Trust:");
    expect(output).toContain("signed by acme-root-2026 (1/1)");
    expect(output).toContain("2026-06-23T00:01:02.000Z");
    expect(output).not.toContain("publicKey");
    expect(output).not.toContain("signature:");
  });

  it("normalizes bare SHA-256 pins before refreshing", async () => {
    const config = {};
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture({
        entries: [{ name: "@acme/calendar" }],
        checksum: "sha256:abcdef",
        includeTrust: false,
      }),
    );

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith({
      feedProfile: "acme",
      expectedSha256: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      requireSnapshotWrite: true,
    });

    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockClear();

    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith({
      feedProfile: "acme",
      expectedSha256: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      requireSnapshotWrite: true,
    });
  });

  it("reports bundled fallback without failing the command", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error: "hosted catalog feed returned HTTP 503",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins",
        status: 503,
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({});

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("bundled fallback");
    expect(output).toContain("hosted catalog feed returned HTTP 503");
    expect(mocks.pluginLifecycleGateway).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("keeps pinned snapshot JSON clean when the Gateway cannot refresh", async () => {
    const config = {};
    mocks.getRuntimeConfig.mockReturnValue(config);
    const result = createHostedMarketplaceFeedFixture({ source: "hosted-snapshot" });
    Object.freeze(result.metadata);
    Object.freeze(result.snapshot);
    Object.freeze(result);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(result);
    mocks.pluginLifecycleGateway.mockRejectedValue(new Error("runtime unavailable"));

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await expect(
      runPluginMarketplaceRefreshCommand({ expectedSha256: "sha256:expected", json: true }),
    ).rejects.toThrow("exit 1");

    expect(mocks.pluginLifecycleGateway).toHaveBeenCalledWith("plugins.refresh", {});
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("Gateway runtime application failed: runtime unavailable"),
      "Pinned marketplace feed refresh did not accept a fresh hosted payload (source: hosted-snapshot).",
    ]);
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledOnce();
    const payload = mocks.defaultRuntime.writeJson.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).toBe(
      '{"source":"hosted-snapshot","entries":0,"metadata":{"url":"https://packages.acme.example/openclaw/feed","status":200,"checksum":"feed-sha"},"feed":{"id":"acme-marketplace","generatedAt":"2026-06-23T00:00:00.000Z","sequence":7},"trust":{"mode":"signed","signedBy":"acme-root-2026","signatureCount":1,"threshold":1,"verifiedAt":"2026-06-23T01:02:03.000Z"},"snapshot":{"savedAt":"2026-06-23T01:02:03.000Z"},"error":"hosted catalog feed offline mode"}',
    );
    expect(Object.keys(payload)).toEqual([
      "source",
      "entries",
      "metadata",
      "feed",
      "trust",
      "snapshot",
      "error",
    ]);
    expect(mocks.defaultRuntime.error.mock.calls.map(([message]) => message)).toEqual([
      "Marketplace catalog saved, but Gateway runtime application failed: runtime unavailable. Repair the reported problem, then rerun this refresh.",
      "Pinned marketplace feed refresh did not accept a fresh hosted payload (source: hosted-snapshot).",
    ]);
    const outputOrder = [
      ...mocks.defaultRuntime.writeJson.mock.invocationCallOrder,
      ...mocks.defaultRuntime.error.mock.invocationCallOrder,
      ...mocks.defaultRuntime.exit.mock.invocationCallOrder,
    ];
    expect(outputOrder).toEqual(outputOrder.toSorted((left, right) => left - right));
  });

  it("keeps a hosted refresh successful and reports next-start state when the Gateway is offline", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture(),
    );
    mocks.resolvePluginLifecycleGateway.mockResolvedValue(null);

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({});

    expect(mocks.defaultRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining("Marketplace catalog saved for the next Gateway start."),
    );
    expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("keeps JSON stdout clean when the Gateway is offline", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture(),
    );
    mocks.resolvePluginLifecycleGateway.mockResolvedValue(null);

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({ json: true });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Marketplace catalog saved for the next Gateway start."),
    );
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each(["failure", "missing-receipt"])(
    "reports a known Gateway %s without corrupting hosted feed JSON",
    async (mode) => {
      mocks.getRuntimeConfig.mockReturnValue({});
      mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
        createHostedMarketplaceFeedFixture(),
      );
      if (mode === "failure") {
        mocks.pluginLifecycleGateway.mockRejectedValue(new Error("owner unreachable"));
      } else {
        mocks.pluginLifecycleGateway.mockResolvedValue({ ok: true });
      }
      const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
      await expect(runPluginMarketplaceRefreshCommand({ json: true })).rejects.toThrow("exit 1");
      expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ source: "hosted" }),
      );
      expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Gateway runtime application failed"),
      );
      expect(mocks.pluginLifecycleGateway).toHaveBeenCalledOnce();
    },
  );

  it("redacts query-bearing feed URLs from refresh output", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    const result = Object.freeze({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error:
        "hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
      metadata: Object.freeze({
        url: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
        status: 503,
      }),
    });
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(result);

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedUrl: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
      json: true,
    });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ url: "https://clawhub.ai/v1/feeds/plugins" }),
        error: "hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins",
      }),
    );

    const payload = mocks.defaultRuntime.writeJson.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).toBe(
      '{"source":"bundled-fallback","entries":1,"metadata":{"url":"https://clawhub.ai/v1/feeds/plugins","status":503},"error":"hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins"}',
    );
    expect(Object.keys(payload)).toEqual(["source", "entries", "metadata", "error"]);
    expect(result.metadata.url).toBe("https://clawhub.ai/v1/feeds/plugins?token=secret#frag");
    expect(result.error).toBe(
      "hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
    );

    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.log.mockClear();

    await runPluginMarketplaceRefreshCommand({
      feedUrl: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
    });

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("https://clawhub.ai/v1/feeds/plugins");
    expect(output).not.toContain("token=secret");
    expect(output).not.toContain("#frag");
    expect(stripVTControlCharacters(output)).toBe(
      [
        "Source: bundled fallback",
        "Entries: 1",
        "URL: https://clawhub.ai/v1/feeds/plugins",
        "Fallback reason: hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins",
      ].join("\n"),
    );
  });

  it("fails checksum-pinned refreshes that fall back", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error: "hosted catalog feed checksum mismatch: expected sha256:expected",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins",
        status: 200,
        checksum: "sha256:actual",
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await expect(
      runPluginMarketplaceRefreshCommand({ expectedSha256: "sha256:expected", json: true }),
    ).rejects.toThrow("exit 1");

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ source: "bundled-fallback" }),
    );
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      "Pinned marketplace feed refresh did not accept a fresh hosted payload (source: bundled-fallback).",
    );
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("emits bounded diagnostics for refresh without raw feed URLs", async () => {
    const timelinePath = await createTimelinePath();
    vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timelinePath);
    const config = {
      diagnostics: { flags: ["timeline"] },
    };
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture({
        entries: [{ name: "@acme/calendar" }, { name: "@acme/docs" }],
        url: "https://user:secret@packages.acme.example/openclaw/feed?token=leak#frag",
        etag: '"abc"',
      }),
    );

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      expectedSha256: "feed-sha",
      feedProfile: "acme",
      feedUrl: "https://override.example/openclaw/feed?token=override-leak",
    });

    const [event] = await readTimeline(timelinePath);
    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        feedUrl: "https://override.example/openclaw/feed?token=override-leak",
      }),
    );
    expect(event?.name).toBe("plugins.marketplace.feed.refresh");
    expect(event?.phase).toBe("plugin-marketplace");
    expect(event?.attributes).toMatchObject({
      command: "refresh",
      entries: 2,
      expectedSha256Provided: true,
      feedIdPresent: true,
      feedProfileProvided: true,
      feedSequence: 7,
      feedTrustMode: "signed",
      feedTrustSignatureCount: 1,
      feedTrustThreshold: 1,
      feedTrustVerified: true,
      feedUrlOverride: true,
      hasEtag: true,
      payloadChecksumPresent: true,
      source: "hosted",
    });
    expect(event?.attributes).toEqual({
      command: "refresh",
      entries: 2,
      expectedSha256Provided: true,
      feedIdPresent: true,
      feedProfileProvided: true,
      feedSequence: 7,
      feedTrustMode: "signed",
      feedTrustSignatureCount: 1,
      feedTrustThreshold: 1,
      feedTrustVerified: true,
      feedUrlOverride: true,
      hasEtag: true,
      hasLastModified: false,
      httpStatus: 200,
      payloadChecksumPresent: true,
      source: "hosted",
    });
    expect(JSON.stringify(event)).not.toContain("packages.acme.example");
    expect(JSON.stringify(event)).not.toContain("acme-marketplace");
    expect(JSON.stringify(event)).not.toContain("feed-sha");
    expect(JSON.stringify(event)).not.toContain("acme-root-2026");
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("token=leak");
    expect(JSON.stringify(event)).not.toContain("override-leak");
  });
});
