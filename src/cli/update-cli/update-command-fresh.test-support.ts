import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import { defaultRuntime } from "../../runtime.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import * as shared from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";

export const targetMetadata = {
  target: "2026.9.2",
  version: "2026.9.2",
  nodeEngine: null,
  schemaVersions: { state: 16, agent: 19 },
};

export function installFreshUpdateFixture() {
  const dirs = createTempDirTracker();
  const fixture: { root: string; databasePath: string; managedServiceNodeRunner?: string } = {
    root: "",
    databasePath: "",
  };
  beforeEach(() => {
    fixture.managedServiceNodeRunner = undefined;
    const home = dirs.make("openclaw-update-fresh-preview-");
    fixture.root = path.join(home, "installation");
    fs.mkdirSync(fixture.root);
    fs.writeFileSync(
      path.join(fixture.root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "profile"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, "profile", "openclaw.json"));
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
    fixture.databasePath = resolveOpenClawStateSqlitePath(process.env);
    const executorRoot = path.join(home, "executor");
    fs.mkdirSync(executorRoot);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(executorRoot);
    // The macOS test sandbox denies /bin/ps. Keep real lease ownership and liveness,
    // supplying only the stable self identity that the OS probe cannot read here.
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((pid) =>
      pid === process.pid ? 1_700_000_000 : null,
    );
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(commandRun, "prepareUpdateCommand").mockImplementation(async (opts) => ({
      startedAt: Date.now(),
      postCoreUpdateResume: false,
      postCoreUpdateChannel: undefined,
      timeoutMs: 5_000,
      shouldRestart: opts.restart !== false,
      requestedChannel: opts.channel === "stable" ? "stable" : null,
      devTarget: undefined,
      controlPlaneUpdateSentinelMeta: null,
      discoveredRoot: fixture.root,
      installKind: "package",
      servicePlan: { rootRedirect: null, nodeRunner: fixture.managedServiceNodeRunner },
    }));
    vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(false);
    vi.spyOn(databaseContext, "inspectUpdateDatabaseContexts").mockImplementation(async () => ({
      service: undefined,
      services: new Map(),
      contexts: [await captureTargetDatabaseSchemaContext(process.env)],
      managedEnv: undefined,
    }));
    vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
    vi.spyOn(shared, "resolveTargetVersion").mockResolvedValue("2026.9.2");
    vi.spyOn(updateGlobal, "createGlobalInstallEnv").mockResolvedValue({ ...process.env });
    vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue({
      manager: "npm",
      command: "npm",
      globalRoot: path.dirname(fixture.root),
      packageRoot: fixture.root,
      npmOwner: { version: "11.10.0", lifecyclePolicy: "unflagged" },
    });
    vi.spyOn(updateCheck, "resolveNpmChannelTag").mockResolvedValue({
      tag: "latest",
      version: "2026.9.2",
    });
    vi.spyOn(packageMetadata, "fetchNpmPackageTargetStatus").mockResolvedValue(targetMetadata);
    vi.spyOn(packageUpdate, "stagePackageInstallUpdate").mockRejectedValue(
      new Error("Read-only update admission must not stage a package"),
    );
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    dirs.cleanup();
  });

  return { fixture, dirs };
}
