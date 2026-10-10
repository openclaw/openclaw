import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { ExpectedCliError, formatCliJsonFailure } from "./failure-output.js";
import { registerPluginsCli } from "./plugins-cli.js";
import {
  runPluginMarketplaceEntriesCommand as entries,
  runPluginMarketplaceRefreshCommand as refresh,
} from "./plugins-cli.runtime.js";
import { createHostedMarketplaceFeedFixture as feed } from "./plugins-marketplace-feed.test-support.js";
import { runPluginMarketplaceListCommand as list } from "./plugins-marketplace-list-command.js";

const mocks = vi.hoisted(() => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn(),
  },
  clearManagedPluginCatalogCache: vi.fn(),
  getRuntimeConfig: vi.fn(),
  listMarketplacePlugins: vi.fn(),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: vi.fn(),
  pluginLifecycleGateway: vi.fn(),
  resolvePluginLifecycleGateway: vi.fn(),
}));
vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries:
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries,
}));
vi.mock("../plugins/marketplace.js", () => ({
  listMarketplacePlugins: mocks.listMarketplacePlugins,
}));
vi.mock("../plugins/management-catalog.js", () => ({
  clearManagedPluginCatalogCache: mocks.clearManagedPluginCatalogCache,
}));
vi.mock("./plugins-lifecycle-client.js", () => ({
  resolvePluginLifecycleGateway: mocks.resolvePluginLifecycleGateway,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = mocks.defaultRuntime;
const loadFeed = mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries;
const output = () => runtime.log.mock.calls.map(([value]) => String(value)).join("\n");
const warning = "Previous plugin service could not stop.";
const privateUrl = "https://user:secret@packages.acme.example/openclaw/feed?token=leak#frag";
const calendar = {
  name: "@acme/calendar",
  openclaw: { plugin: { id: "acme-calendar", label: "Acme Calendar" } },
};
async function marketplaceCommand(args: string[]) {
  const program = new Command();
  registerPluginsCli(program);
  await program.parseAsync(["plugins", "marketplace", ...args], { from: "user" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntimeConfig.mockReset().mockReturnValue({});
  loadFeed.mockReset();
  mocks.listMarketplacePlugins.mockReset();
  mocks.resolvePluginLifecycleGateway.mockReset().mockResolvedValue(mocks.pluginLifecycleGateway);
  mocks.pluginLifecycleGateway.mockReset().mockResolvedValue({ runtime: { generation: 4 } });
  vi.unstubAllEnvs();
});
afterEach(() => {
  flushDiagnosticsTimeline();
  vi.unstubAllEnvs();
});

function timeline(): string {
  const filename = path.join(tempDirs.make("openclaw-marketplace-"), "timeline.jsonl");
  vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", filename);
  return filename;
}
async function expectTimeline(
  filename: string,
  command: string,
  attributes: Record<string, unknown>,
) {
  flushDiagnosticsTimeline();
  const content = await readFile(filename, "utf8");
  expect(JSON.parse(content.trim())).toMatchObject({
    name: `plugins.marketplace.feed.${command}`,
    phase: "plugin-marketplace",
    attributes: {
      command,
      feedIdPresent: true,
      feedSequence: 7,
      feedTrustMode: "signed",
      feedTrustSignatureCount: 1,
      feedTrustThreshold: 1,
      feedTrustVerified: true,
      payloadChecksumPresent: true,
      ...attributes,
    },
  });
  expect(content).not.toMatch(
    /packages\.acme\.example|acme-marketplace|feed-sha|acme-root-2026|secret|token=leak|override-leak/,
  );
}

describe("plugins marketplace entries", () => {
  it("lists the selected feed with normalized plugin install metadata", async () => {
    loadFeed.mockResolvedValue(
      feed({
        source: "hosted-snapshot",
        entries: [
          {
            ...calendar,
            version: "1.2.3",
            kind: "plugin",
            state: "available",
            publisher: { trust: "official" },
            install: {
              candidates: [
                { sourceRef: "public-npm", package: "@acme/calendar", version: "1.2.3" },
              ],
            },
          },
        ],
      }),
    );
    await marketplaceCommand(["entries", "--feed-profile", "acme", "--offline", "--json"]);
    expect(loadFeed).toHaveBeenCalledWith({ feedProfile: "acme", offline: true });
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "hosted-snapshot",
        entryCount: 1,
        entries: [
          expect.objectContaining({
            id: "acme-calendar",
            label: "Acme Calendar",
            name: "@acme/calendar",
            version: "1.2.3",
            install: expect.objectContaining({ npmSpec: "@acme/calendar@1.2.3" }),
          }),
        ],
      }),
    );
  });

  it.each(["metadata", "override"])(
    "redacts frozen %s URLs without expanding replacement metacharacters",
    async (source) => {
      const publicUrl = ["https://", "feed.example.invalid", "/$&"].join("");
      const rawUrl = `${publicUrl}?token=secret#frag`;
      loadFeed.mockResolvedValue(
        Object.freeze({
          source: "bundled-fallback",
          entries: [],
          error: `feed fetch failed for ${rawUrl}`,
          ...(source === "metadata"
            ? { metadata: Object.freeze({ url: rawUrl, status: 503 }) }
            : {}),
        }),
      );
      const feedUrl = source === "override" ? rawUrl : undefined;
      await entries({ feedUrl, json: true });
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          ...(source === "metadata"
            ? { metadata: expect.objectContaining({ url: publicUrl }) }
            : {}),
          error: `feed fetch failed for ${publicUrl}`,
        }),
      );
      expect(JSON.stringify(runtime.writeJson.mock.calls)).not.toContain("token=secret");
      await entries({ feedUrl });
      expect(output()).toContain(publicUrl);
      expect(output()).not.toMatch(/token=secret|#frag/);
    },
  );

  it("bounds signed snapshot output and diagnostics", async () => {
    const filename = timeline();
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "1");
    loadFeed.mockResolvedValue(
      feed({
        source: "hosted-snapshot",
        url: privateUrl,
        entries: [calendar],
      }),
    );
    await entries({ feedProfile: "acme", offline: true });
    expect(output()).toContain("signed by acme-root-2026 (1/1)");
    expect(output()).toContain("2026-06-23T01:02:03.000Z");
    expect(output()).not.toMatch(/publicKey|signature:/);
    await expectTimeline(filename, "entries", {
      entries: 1,
      fallbackCategory: "offline",
      feedProfileProvided: true,
      offline: true,
      snapshotUsed: true,
      source: "hosted-snapshot",
    });
  });
});

describe("plugins marketplace refresh", () => {
  const checksum = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
  it.each([checksum, `sha256:${checksum}`])(
    "normalizes pin %s and keeps warnings off JSON stdout",
    async (expectedSha256) => {
      loadFeed.mockResolvedValue(
        feed({ entries: [calendar], checksum: "sha256:abcdef", includeTrust: false }),
      );
      mocks.pluginLifecycleGateway.mockResolvedValue({
        runtime: { generation: 4 },
        ...(expectedSha256 === checksum ? {} : { warnings: [warning] }),
      });
      await marketplaceCommand([
        "refresh",
        "--feed-profile",
        "acme",
        "--expected-sha256",
        expectedSha256,
        "--json",
      ]);
      expect(loadFeed).toHaveBeenCalledWith({
        feedProfile: "acme",
        expectedSha256: `sha256:${checksum.toLowerCase()}`,
        requireSnapshotWrite: true,
      });
      expect(mocks.pluginLifecycleGateway).toHaveBeenCalledWith("plugins.refresh", {});
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "hosted",
          entries: 1,
          metadata: expect.objectContaining({ checksum: "sha256:abcdef" }),
        }),
      );
      expect(runtime.log).not.toHaveBeenCalled();
      if (expectedSha256 === checksum) {
        expect(runtime.error).not.toHaveBeenCalled();
      } else {
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(warning));
      }
    },
  );

  it("reports signed runtime application with bounded diagnostics", async () => {
    const filename = timeline();
    mocks.getRuntimeConfig.mockReturnValue({ diagnostics: { flags: ["timeline"] } });
    loadFeed.mockResolvedValue(
      feed({ entries: [{ name: "@acme/calendar" }], url: privateUrl, etag: '"abc"' }),
    );
    mocks.pluginLifecycleGateway.mockResolvedValue({
      runtime: { generation: 4 },
      warnings: [warning],
    });
    await refresh({
      expectedSha256: "feed-sha",
      feedProfile: "acme",
      feedUrl: "https://override.example/openclaw/feed?token=override-leak",
    });
    expect(output()).toContain(warning);
    expect(output()).toContain("Marketplace catalog applied in Gateway generation 4.");
    expect(output()).toContain("signed by acme-root-2026 (1/1)");
    expect(output()).toContain("2026-06-23T00:01:02.000Z");
    expect(output()).not.toMatch(/publicKey|signature:/);
    await expectTimeline(filename, "refresh", {
      entries: 1,
      expectedSha256Provided: true,
      feedProfileProvided: true,
      feedUrlOverride: true,
      hasEtag: true,
      source: "hosted",
    });
  });

  it("rejects a pinned refresh when the feed falls back", async () => {
    loadFeed.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error: "hosted catalog feed checksum mismatch: expected sha256:expected",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins",
        status: 200,
        checksum: "sha256:actual",
      },
    });
    await expect(refresh({ expectedSha256: "sha256:expected", json: true })).rejects.toThrow(
      "exit 1",
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ source: "bundled-fallback" }),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "Pinned marketplace feed refresh did not accept a fresh hosted payload (source: bundled-fallback).",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.pluginLifecycleGateway).not.toHaveBeenCalled();
  });

  it.each(["snapshot", "receipt"])(
    "reports a failed %s application without corrupting JSON",
    async (failure) => {
      const snapshot = failure === "snapshot";
      loadFeed.mockResolvedValue(feed({ source: snapshot ? "hosted-snapshot" : "hosted" }));
      if (snapshot) {
        mocks.pluginLifecycleGateway.mockRejectedValue(new Error("runtime unavailable"));
      } else {
        mocks.pluginLifecycleGateway.mockResolvedValue({ ok: true });
      }
      await expect(
        refresh({ json: true, ...(snapshot ? { expectedSha256: "sha256:expected" } : {}) }),
      ).rejects.toThrow("exit 1");
      expect(mocks.pluginLifecycleGateway).toHaveBeenCalledExactlyOnceWith("plugins.refresh", {});
      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ source: snapshot ? "hosted-snapshot" : "hosted" }),
      );
      expect(runtime.log).not.toHaveBeenCalled();
      if (snapshot) {
        expect(runtime.error.mock.calls.map(([message]) => message)).toEqual([
          expect.stringContaining("Gateway runtime application failed: runtime unavailable"),
          "Pinned marketplace feed refresh did not accept a fresh hosted payload (source: hosted-snapshot).",
        ]);
      } else {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Gateway runtime application failed"),
        );
      }
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("keeps offline refresh successful and next-start notices off JSON stdout", async () => {
    loadFeed.mockResolvedValue(feed());
    mocks.resolvePluginLifecycleGateway.mockResolvedValue(null);
    await refresh({ json: true });
    expect(runtime.writeJson).toHaveBeenCalledOnce();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Marketplace catalog saved for the next Gateway start."),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});

describe("plugins marketplace list", () => {
  const source = "owner/repo";
  const manifest = {
    name: "QA Marketplace",
    version: "1.0.0",
    plugins: [
      ["numeric", "1.2.3"],
      ["prefixed", "v1.2.3"],
      ["missing", undefined],
    ].map(([name, version]) => ({
      name,
      version,
      source: { kind: "path", path: "./plugins/demo" },
    })),
  };
  function result(error?: string) {
    mocks.listMarketplacePlugins.mockImplementationOnce(
      async ({ logger }: { logger?: { info?: (message: string) => void } }) => {
        logger?.info?.(`Cloning marketplace source ${source}...`);
        return error ? { ok: false, error } : { ok: true, sourceLabel: source, manifest };
      },
    );
  }
  it.each([false, true])(
    "renders marketplace versions and routes progress (json=%s)",
    async (json) => {
      result();
      await list(source, { json });
      if (json) {
        expect(runtime.log).not.toHaveBeenCalled();
        expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith({ source, ...manifest });
      } else {
        expect(runtime.log.mock.calls.map(([line]) => String(line))).toEqual([
          `Cloning marketplace source ${source}...`,
          expect.stringContaining("QA Marketplace"),
          "numeric v1.2.3",
          "prefixed v1.2.3",
          "missing",
        ]);
        expect(runtime.writeJson).not.toHaveBeenCalled();
      }
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it("hands quiet failures to the canonical JSON error renderer", async () => {
    const message = "mock git remote unavailable";
    result(message);
    const failure = await list(source, { json: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExpectedCliError);
    expect(formatCliJsonFailure(failure)).toEqual({
      ok: false,
      error: { type: "cli_error", message },
    });
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
