import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clawHubSecurityResponse, clawHubVersionMetadata } from "./clawhub.test-fixtures.js";
import {
  clawHubArchiveFile,
  clawHubPackageDetail,
  createClawHubArchiveFactory,
  DEMO_PLUGIN_ARCHIVE_ENTRIES,
} from "./clawhub.test-support.js";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  security: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: mocks.detail,
  fetchClawHubPackageArtifact: mocks.artifact,
  fetchClawHubPackageSecurity: mocks.security,
}));
vi.mock("../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: mocks.download,
}));

const homes = useAutoCleanupTempDirTracker(afterAll);
const home = homes.make("openclaw-clawhub-authority-home-");
const createArchive = createClawHubArchiveFactory(afterEach);
let installPluginFromClawHub: typeof import("./clawhub.js").installPluginFromClawHub;
beforeAll(async () => {
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: path.join(home, ".openclaw"),
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_CONFIG_PATH: path.join(home, "config.json"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
  })) {
    vi.stubEnv(key, value);
  }
  ({ installPluginFromClawHub } = await import("./clawhub.js"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
afterAll(() => vi.unstubAllEnvs());

it.each([
  { baseUrl: "https://clawhub.ai", blocked: false },
  { baseUrl: "https://mirror.example.test", blocked: true },
])("binds official archive hook bypass to the registry $baseUrl", async ({ baseUrl, blocked }) => {
  const archive = await createArchive(DEMO_PLUGIN_ARCHIVE_ENTRIES);
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const extensionsDir = path.join(path.dirname(archive.archivePath), "extensions");
  mocks.detail.mockResolvedValueOnce(
    clawHubPackageDetail({
      verification: { tier: "source-linked", sourceRepo: "openclaw/openclaw" },
    }),
  );
  mocks.artifact.mockResolvedValueOnce(
    clawHubVersionMetadata({
      files: Object.entries(DEMO_PLUGIN_ARCHIVE_ENTRIES).map(([filePath, contents]) =>
        clawHubArchiveFile(filePath, contents),
      ),
    }),
  );
  mocks.security.mockResolvedValueOnce(clawHubSecurityResponse());
  mocks.download.mockResolvedValueOnce({ ...archive, cleanup });
  const { createHookRunner } = await import("./hooks.js");
  const { createMockPluginRegistry } = await import("./hooks.test-helpers.js");
  const hookRunnerGlobal = await import("./hook-runner-global.js");
  const rejectInstall = vi.fn().mockReturnValue({
    block: true,
    blockReason: "registry policy rejected fixture",
  });
  const hookRunner = createHookRunner(
    createMockPluginRegistry([
      { pluginId: "registry-policy", hookName: "before_install", handler: rejectInstall },
    ]),
  );
  const archiveApi = await import("../infra/archive.js");
  vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(hookRunner);
  const extraction = vi.spyOn(archiveApi, "extractArchive");
  const artifactReview = vi.fn();
  const result = await installPluginFromClawHub({
    spec: "clawhub:demo@2026.3.22",
    baseUrl,
    config: {},
    extensionsDir,
    env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.3.22" },
    onInstallPolicyWarning: async () => ({ status: "approved" }),
    onBeforePluginArtifactCommit: artifactReview,
  });
  expect(mocks.detail).toHaveBeenCalledWith(expect.objectContaining({ baseUrl }));
  expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({ baseUrl }));
  expect(extraction).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  if (blocked) {
    expect(result).toMatchObject({
      ok: false,
      code: "security_scan_blocked",
      error: expect.stringContaining("registry policy rejected fixture"),
    });
    expect(rejectInstall).toHaveBeenCalledOnce();
    expect(artifactReview).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(extensionsDir, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } else {
    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
    expect(rejectInstall).not.toHaveBeenCalled();
    expect(artifactReview).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(extensionsDir, "demo", "index.js"), "utf8")).toBe(
      DEMO_PLUGIN_ARCHIVE_ENTRIES["index.js"],
    );
  }
});
