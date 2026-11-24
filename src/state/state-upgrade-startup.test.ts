import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import * as processRole from "../infra/database-engine/admission-scope.js";
import { createTrialPending, resolvePrefix, writeTrial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
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
  { name: "without a key", apiKey: undefined, trial: false },
  { name: "with a key", apiKey: "synthetic-provider-key", trial: false },
  { name: "during a managed trial", apiKey: undefined, trial: true },
])("reopens published state after provider config admission $name", async ({ apiKey, trial }) => {
  vi.spyOn(processRole, "getDatabaseProcessRole").mockReturnValue("gateway");
  const stateDir = dirs.make("state-upgrade-reader-");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: { mode: "local" },
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1", apiKey, models: [] },
        },
      },
    }),
  );
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
  const manifestFile = path.join(resolvePrefix(env), "releases", ".restore");
  if (trial) {
    const pending = await createTrialPending(
      {
        runId: "startup-trial",
        target: stateDir,
        previous: stateDir,
        version: VERSION,
        buildId: resolveRuntimeServiceBuildId() ?? undefined,
      },
      resolvePrefix(env),
    );
    await writeTrial({ ...pending, phase: "trial" }, resolvePrefix(env));
  }

  await withLiveStateReads(async () => {
    await upgradeStateOnGatewayStart(env, ({ mode }) => mode === "local");
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgrade-"))).toBe(false);
    if (trial) {
      const encoded = fs.readFileSync(manifestFile, "utf8");
      const manifest = JSON.parse(encoded);
      expect(manifest.runId).toBe("startup-trial");
      const previous = manifest.files.find(
        (entry: { live: string }) => entry.live === path.join(stateDir, "state", "openclaw.sqlite"),
      ).preimage;
      using original = new DatabaseSync(previous, { readOnly: true });
      expect(original.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION - 1,
      );
      await upgradeStateOnGatewayStart(env, () => true);
      expect(fs.readFileSync(manifestFile, "utf8")).toBe(encoded);
    } else {
      expect(fs.existsSync(manifestFile)).toBe(false);
    }
    // Startup reopens the published database in WAL mode before preparing secrets.
    using runtime = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
    runtime.exec("PRAGMA journal_mode = WAL");
    await expect(prepareSharedAuthStoreOwnership(env)).resolves.toEqual({ location: "state-db" });
  });
});

it.each([true, false])(
  "publishes an empty no-upgrade trial plan only for an admitted start (%s)",
  async (admits) => {
    const stateDir = dirs.make("state-upgrade-empty-restore-");
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, '{"gateway":{"mode":"local"}}');
    fs.mkdirSync(path.join(stateDir, "state"));
    const file = path.join(stateDir, "state", "openclaw.sqlite");
    {
      using db = new DatabaseSync(file);
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
    }
    const original = fs.readFileSync(file);
    const pending = await createTrialPending(
      {
        runId: "empty-trial",
        target: stateDir,
        previous: stateDir,
        version: VERSION,
        buildId: resolveRuntimeServiceBuildId() ?? undefined,
      },
      resolvePrefix(env),
    );
    await writeTrial({ ...pending, phase: "trial" }, resolvePrefix(env));
    await upgradeStateOnGatewayStart(env, () => admits);
    const manifest = path.join(resolvePrefix(env), "releases", ".restore");
    if (admits) {
      expect(JSON.parse(fs.readFileSync(manifest, "utf8"))).toEqual({
        v: 1,
        runId: "empty-trial",
        files: [],
      });
    } else {
      expect(fs.existsSync(manifest)).toBe(false);
    }
    expect(fs.readFileSync(file)).toEqual(original);
  },
);
