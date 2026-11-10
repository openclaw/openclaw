import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clawHubVersionMetadata } from "./clawhub.test-fixtures.js";
import {
  clawHubPackageDetail,
  createClawHubArchiveFactory,
  createLoggerSpies,
  DEMO_PLUGIN_ARCHIVE_ENTRIES,
} from "./clawhub.test-support.js";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: mocks.detail,
  fetchClawHubPackageArtifact: mocks.artifact,
}));
vi.mock("../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: mocks.download,
}));

const homes = useAutoCleanupTempDirTracker(afterAll);
const home = homes.make("openclaw-clawhub-cleanup-home-");
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
afterEach(() => vi.resetAllMocks());
afterAll(() => vi.unstubAllEnvs());

it.each([true, false])(
  "warns about temporary archive cleanup failure without replacing install success %s",
  async (success) => {
    const archive = await createArchive(DEMO_PLUGIN_ARCHIVE_ENTRIES);
    const cleanup = vi.fn().mockRejectedValue(new Error("fixture archive cleanup failed"));
    const logger = createLoggerSpies();
    mocks.detail.mockResolvedValueOnce(clawHubPackageDetail({ latestVersion: "2026.3.22" }));
    mocks.artifact.mockResolvedValueOnce(clawHubVersionMetadata({ sha256hash: archive.integrity }));
    mocks.download.mockResolvedValueOnce({ ...archive, cleanup });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo@2026.3.22",
      logger,
      dryRun: true,
      extensionsDir: path.join(path.dirname(archive.archivePath), "extensions"),
      expectedPluginId: success ? "demo" : "other",
      env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.3.22" },
    });
    expect(result).toMatchObject(
      success
        ? { ok: true, pluginId: "demo", version: "2026.3.22" }
        : { ok: false, code: "plugin_id_mismatch" },
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to remove temporary ClawHub archive: fixture archive cleanup failed",
    );
  },
);
