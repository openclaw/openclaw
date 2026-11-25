import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import * as processRole from "../infra/database-engine/admission-scope.js";
import { withLiveStateReads } from "./artifact-preserving-state-reads.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { upgradeStateOnGatewayStart } from "./state-upgrade-startup.js";

vi.mock("./state-upgrade-doctor.js", async (original) => ({
  ...(await original<typeof import("./state-upgrade-doctor.js")>()),
  // The fixture already has current tables; only the schema stamp needs upgrading.
  // Keep config admission, native readers, publication, and cleanup real.
  createDoctorChain:
    () =>
    async ({ stateDir }: { stateDir: string }) => {
      using db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
      return { warnings: [] };
    },
}));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

it.each([
  { name: "without a key", apiKey: undefined, layout: "inline" },
  { name: "with a key", apiKey: "synthetic-provider-key", layout: "inline" },
  { name: "beside an external config", apiKey: undefined, layout: "external" },
  { name: "inside the workspace", apiKey: undefined, layout: "workspace" },
  { name: "with a missing include", apiKey: undefined, layout: "missing" },
])("reopens published state after provider config admission $name", async ({ apiKey, layout }) => {
  vi.spyOn(processRole, "getDatabaseProcessRole").mockReturnValue("gateway");
  const root = dirs.make("state-upgrade-reader-");
  const stateDir = path.join(root, "state");
  const configDir = layout === "external" ? path.join(root, "config") : stateDir;
  const workspace = path.join(stateDir, "workspace");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json"),
  };
  const models = {
    providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey, models: [] } },
  };
  const include = layout === "external" ? "models.json" : "workspace/models.json";
  const includePath = path.join(configDir, include);
  if (layout !== "inline" && layout !== "missing") {
    fs.writeFileSync(includePath, JSON.stringify(models));
  }
  const authored = JSON.stringify({
    gateway: { mode: "local" },
    agents: { defaults: { workspace } },
    models: layout === "inline" ? models : { $include: include },
  });
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, authored);
  fs.mkdirSync(path.join(stateDir, "state"));
  {
    using db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
    db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
      "auth.sharedStore",
      JSON.stringify({ location: "state-db" }),
      1,
    );
  }

  await withLiveStateReads(async () => {
    if (layout === "missing") {
      await expect(
        upgradeStateOnGatewayStart(env, ({ mode }) => mode === "local"),
      ).rejects.toMatchObject({
        code: 78,
      });
      using original = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      expect(original.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION - 1,
      });
      expect(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(authored);
      return;
    }
    await upgradeStateOnGatewayStart(env, ({ mode }) => mode === "local");
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgrade-"))).toBe(false);
    expect(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")).toBe(authored);
    if (layout !== "inline") {
      expect(fs.readFileSync(includePath, "utf8")).toBe(JSON.stringify(models));
    }
    // Startup reopens the published database in WAL mode before preparing secrets.
    using runtime = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
    runtime.exec("PRAGMA journal_mode = WAL");
    await expect(prepareSharedAuthStoreOwnership(env)).resolves.toEqual({ location: "state-db" });
  });
});
