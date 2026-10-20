import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
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
const version = { version: "2026.3.22", sha256hash: archiveSha };
const installOptions = { mode: "update" as const, timeoutMs: 1000 };

vi.mock("./install.js", async (original) => ({
  ...(await original<typeof import("./install.js")>()),
  installPluginFromArchive: transport.archive,
  installPluginFromPath: transport.directory,
}));
vi.mock("../infra/clawhub-packages.js", async (original) => ({
  ...(await original<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: transport.metadata,
  fetchClawHubPackageVersion: async () => ({ version }),
  fetchClawHubPackageArtifact: async () => ({ version }),
}));
vi.mock("../infra/clawhub-artifacts.js", async (original) => ({
  ...(await original<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: transport.download,
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

function installMarketplace(workTimeoutMs: number | null | undefined) {
  return withTempDir("openclaw-marketplace-deadline-", async (root) => {
    await fs.mkdir(path.join(root, "plugin"));
    const marketplace = path.join(root, "marketplace.json");
    await fs.writeFile(
      marketplace,
      JSON.stringify({
        name: "fixture-marketplace",
        plugins: [{ name: "demo", source: "./plugin" }],
      }),
    );
    return installPluginFromMarketplace({
      ...installOptions,
      marketplace,
      plugin: "demo",
      workTimeoutMs,
      trustedSourceLinkedOfficialInstall: true,
    });
  });
}

it.each([
  ["ClawHub", undefined],
  ["ClawHub", null],
  ["ClawHub", 5000],
  ["marketplace", undefined],
  ["marketplace", null],
  ["marketplace", 5000],
] as const)("%s preserves work policy %s", async (source, workTimeoutMs) => {
  const clawhub = source === "ClawHub";
  const result = await (clawhub
    ? installPluginFromClawHub({
        ...installOptions,
        spec: "clawhub:demo@2026.3.22",
        workTimeoutMs,
      })
    : installMarketplace(workTimeoutMs));
  const install = clawhub ? transport.archive : transport.directory;
  expect(result.ok).toBe(true);
  expect(install.mock.calls).toEqual([[expect.objectContaining({ workTimeoutMs })]]);
  if (clawhub) {
    for (const request of [transport.metadata, transport.download]) {
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
    }
    expect(transport.cleanup).toHaveBeenCalledOnce();
  } else {
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
    expect(install.mock.calls[0]?.[0].trustedSourceLinkedOfficialInstall).toBeUndefined();
  }
});
