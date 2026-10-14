import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { installPluginFromClawHub } from "./clawhub.js";
import { installPluginFromMarketplace } from "./marketplace.js";

const transport = vi.hoisted(() => ({
  archive: vi.fn(),
  directory: vi.fn(),
  metadata: vi.fn(),
  download: vi.fn(),
  cleanup: vi.fn(),
}));
const archiveSha = "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af";
const archiveIntegrity = "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8=";

vi.mock("./install.js", async (original) => ({
  ...(await original<typeof import("./install.js")>()),
  installPluginFromArchive: (...args: unknown[]) => transport.archive(...args),
  installPluginFromPath: (...args: unknown[]) => transport.directory(...args),
}));
vi.mock("../infra/clawhub-packages.js", async (original) => ({
  ...(await original<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: (...args: unknown[]) => transport.metadata(...args),
  fetchClawHubPackageVersion: async () => ({
    version: { version: "2026.3.22", sha256hash: archiveSha },
  }),
  fetchClawHubPackageArtifact: async () => ({
    version: { version: "2026.3.22", sha256hash: archiveSha },
  }),
}));
vi.mock("../infra/clawhub-artifacts.js", async (original) => ({
  ...(await original<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: (...args: unknown[]) => transport.download(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  transport.cleanup.mockResolvedValue(undefined);
  const success = { ok: true, pluginId: "demo", targetDir: "/fixture/demo", version: "2026.3.22" };
  transport.archive.mockResolvedValue(success);
  transport.directory.mockResolvedValue(success);
  transport.metadata.mockResolvedValue({
    package: {
      name: "demo",
      family: "code-plugin",
      channel: "official",
      isOfficial: true,
      compatibility: { pluginApiRange: "*", minGatewayVersion: "2026.3.0" },
    },
  });
  transport.download.mockResolvedValue({
    archivePath: "/fixture/demo.zip",
    integrity: archiveIntegrity,
    cleanup: transport.cleanup,
  });
});

describe("plugin transport work deadlines", () => {
  it.each([undefined, null, 5000])(
    "preserves ClawHub work policy %s and finite metadata",
    async (workTimeoutMs) => {
      const result = await installPluginFromClawHub({
        spec: "clawhub:demo@2026.3.22",
        mode: "update",
        timeoutMs: 1000,
        workTimeoutMs,
      });
      expect(result.ok).toBe(true);
      expect(transport.archive).toHaveBeenCalledOnce();
      expect(transport.archive).toHaveBeenCalledWith(expect.objectContaining({ workTimeoutMs }));
      expect(transport.metadata).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
      expect(transport.download).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
      expect(transport.cleanup).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, null, 5000])(
    "preserves marketplace work policy %s without granting source trust",
    async (workTimeoutMs) => {
      await withTempDir("openclaw-marketplace-deadline-", async (root) => {
        await fs.mkdir(path.join(root, "plugin"));
        const manifest = path.join(root, "marketplace.json");
        await fs.writeFile(
          manifest,
          JSON.stringify({
            name: "fixture-marketplace",
            plugins: [{ name: "demo", source: "./plugin" }],
          }),
        );
        const result = await installPluginFromMarketplace({
          marketplace: manifest,
          plugin: "demo",
          mode: "update",
          timeoutMs: 1000,
          workTimeoutMs,
          trustedSourceLinkedOfficialInstall: true,
        });
        expect(result.ok).toBe(true);
        expect(transport.directory).toHaveBeenCalledOnce();
        expect(transport.directory).toHaveBeenCalledWith(
          expect.objectContaining({ workTimeoutMs, timeoutMs: 1000 }),
        );
        expect(
          transport.directory.mock.calls[0]?.[0].trustedSourceLinkedOfficialInstall,
        ).toBeUndefined();
      });
    },
  );
});
