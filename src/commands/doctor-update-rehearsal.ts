import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasActiveUpdateDoctorStep } from "../infra/update-run-record.js";
import type { RuntimeEnv } from "../runtime.js";

type DoctorMaintenance = NonNullable<
  Awaited<ReturnType<typeof import("./doctor-maintenance.js").beginDoctorMaintenance>>
>;

const admissionMessage =
  "legacy driver rehearsal admitted: 2026.9.3-style invocation, disposable copy verified";

type LegacyDoctorRehearsal = {
  fact: {
    kind: "legacy-driver-rehearsal";
    driverStyle: "2026.9.3";
    message: string;
    stateDir: string;
  };
  assertPrepared(): void;
  assertCurrent(): void;
};

function refuse(detail: string): never {
  throw new Error(
    `Legacy update rehearsal was refused: ${detail}. Run npx openclaw@latest update from a terminal for a protected update.`,
  );
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function valueAt(value: unknown, keys: string): unknown {
  let current = value;
  for (const key of keys.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function assertConfigLayout(config: unknown, stateDir: string): void {
  const workspace = path.join(stateDir, "workspace");
  const expected: Record<string, unknown> = {
    "agents.defaults.workspace": workspace,
    "agents.defaults.cwd": workspace,
    "agents.defaults.heartbeat.every": "0m",
    "logging.file": path.join(stateDir, "canary.log"),
    "gateway.mode": "local",
    "gateway.bind": "loopback",
    "gateway.auth.mode": "token",
    "gateway.tls.enabled": false,
    "gateway.tailscale.mode": "off",
    "gateway.controlUi.enabled": false,
    "cron.enabled": false,
    "cron.triggers.enabled": false,
    "hooks.enabled": false,
    "hooks.internal.enabled": false,
    "transcripts.enabled": false,
    "discovery.mdns.mode": "off",
  };
  if (Object.entries(expected).some(([key, value]) => valueAt(config, key) !== value)) {
    refuse("configuration does not preserve the shipped isolated layout");
  }
  for (const key of ["env", "diagnostics", "session.store", "agents.list"]) {
    if (valueAt(config, key) !== undefined) {
      refuse(`configuration retains ${key}`);
    }
  }
  const port = valueAt(config, "gateway.port");
  const token = valueAt(config, "gateway.auth.token");
  const autoStart = valueAt(config, "transcripts.autoStart");
  const agents = valueAt(config, "agents.entries");
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof token !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(token) ||
    !Array.isArray(autoStart) ||
    autoStart.length !== 0 ||
    !isRecord(agents)
  ) {
    refuse("configuration is missing its isolated Gateway or agent projection");
  }
  for (const [id, agent] of Object.entries(agents)) {
    const agentWorkspace = path.join(workspace, id);
    const agentDir = valueAt(agent, "agentDir");
    if (
      !within(workspace, agentWorkspace) ||
      valueAt(agent, "workspace") !== agentWorkspace ||
      valueAt(agent, "cwd") !== agentWorkspace ||
      valueAt(agent, "heartbeat.every") !== "0m" ||
      typeof agentDir !== "string" ||
      !path.isAbsolute(agentDir) ||
      !within(stateDir, agentDir)
    ) {
      refuse("an agent points outside its copied layout");
    }
  }
  const pending: unknown[] = [config];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
    } else if (isRecord(value)) {
      if (Object.hasOwn(value, "$include")) {
        refuse("configuration retains an include graph");
      }
      pending.push(...Object.values(value));
    }
  }
}

// Shipped 2026.9.3/2026.9.4 drivers supply no copy receipt. Remove this contract
// when those releases are no longer supported upgrade sources.
async function inspectLegacyDoctorRehearsal(): Promise<LegacyDoctorRehearsal | undefined> {
  const env = { ...process.env };
  const selectedStateDir = env.OPENCLAW_STATE_DIR;
  if (
    env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" ||
    !selectedStateDir ||
    !/^openclaw-update-canary-[a-z0-9]{6}$/iu.test(path.basename(selectedStateDir))
  ) {
    return undefined;
  }
  const stateDir = selectedStateDir;
  const [markers, postCore, sentinel, driver, processTree] = await Promise.all([
    import("../infra/supervisor-markers.js"),
    import("../infra/update-post-core-context.js"),
    import("../infra/update-control-plane-sentinel.js"),
    import("../infra/update-run-driver.js"),
    import("../infra/restart-stale-pids.js"),
  ]);
  const required: NodeJS.ProcessEnv = {
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
    OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
    OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: "1",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    HOME: stateDir,
    USERPROFILE: stateDir,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    TMPDIR: stateDir,
    TMP: stateDir,
    TEMP: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_OAUTH_DIR: env.OPENCLAW_OAUTH_DIR,
    OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
    XDG_CONFIG_HOME: path.join(stateDir, "config"),
    XDG_CACHE_HOME: path.join(stateDir, "cache"),
    XDG_DATA_HOME: path.join(stateDir, "data"),
    XDG_STATE_HOME: path.join(stateDir, "state"),
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  const cleared = [
    ...markers.SUPERVISOR_HINT_ENV_VARS,
    sentinel.CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
    sentinel.UPDATE_RUN_ID_ENV,
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    postCore.POST_CORE_UPDATE_ENV,
    postCore.POST_CORE_UPDATE_CHANNEL_ENV,
    postCore.POST_CORE_UPDATE_RESULT_PATH_ENV,
    postCore.POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
    postCore.POST_CORE_UPDATE_STARTED_AT_ENV,
    postCore.POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
    postCore.POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_GATEWAY_SERVICE_PID",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_COMPATIBILITY_HOST_VERSION",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_PROFILE",
    "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
  ];
  for (const key of cleared) {
    required[key] = undefined;
  }
  for (const key of ["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    if (env[key] && (!path.isAbsolute(env[key]) || !within(stateDir, env[key]))) {
      refuse("an agent environment selector escapes the copy");
    }
    required[key] = env[key];
  }
  const assertEnv = () => {
    if (Object.entries(required).some(([key, value]) => process.env[key] !== value)) {
      refuse("the isolated environment changed or retained live selectors");
    }
  };
  assertEnv();
  const uid = process.getuid?.();
  const identities = new Map<string, Stats>();
  function inspectPath(filename: string, privateMode = false): Stats | undefined {
    if (!path.isAbsolute(filename) || !within(stateDir, filename)) {
      refuse(`migration data escapes the copied state: ${filename}`);
    }
    let current = stateDir;
    let last: Stats | undefined;
    for (const part of ["", ...path.relative(stateDir, filename).split(path.sep).filter(Boolean)]) {
      current = path.join(current, part);
      try {
        last = lstatSync(current);
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      if (
        last.isSymbolicLink() ||
        (!last.isDirectory() && !last.isFile()) ||
        (last.isFile() && last.nlink !== 1) ||
        (uid !== undefined && last.uid !== uid) ||
        (process.platform !== "win32" &&
          (current === stateDir || (privateMode && current === filename)) &&
          (last.mode & 0o077) !== 0)
      ) {
        refuse(`copied data has unsafe ownership or links: ${current}`);
      }
      const previous = identities.get(current);
      if (previous && (previous.dev !== last.dev || previous.ino !== last.ino)) {
        refuse(`copied data identity changed: ${current}`);
      }
      identities.set(current, last);
    }
    return last;
  }
  const rootIdentity = inspectPath(stateDir);
  if (
    !rootIdentity?.isDirectory() ||
    path.resolve(stateDir) !== stateDir ||
    realpathSync(stateDir) !== stateDir
  ) {
    refuse("the rehearsal root is not a private canonical directory");
  }
  const configPath = path.join(stateDir, "openclaw.json");
  if (!inspectPath(configPath, true)?.isFile()) {
    refuse("the copied configuration is missing");
  }
  const raw = await fs.readFile(configPath, "utf8");
  inspectPath(configPath, true);
  const parsed: unknown = JSON.parse(raw);
  assertConfigLayout(parsed, stateDir);
  const [
    { readConfigFileSnapshot },
    registryApi,
    targets,
    plugins,
    workshop,
    stateReader,
    sqlite,
    schema,
    paths,
    runsApi,
    sqliteFiles,
    fileHeader,
    configPaths,
  ] = await Promise.all([
    import("../config/config.js"),
    import("../state/openclaw-agent-db-registry-listing.js"),
    import("../config/sessions/targets.js"),
    import("../plugins/doctor-contract-registry.js"),
    import("./doctor-skill-workshop-readonly.js"),
    import("../state/openclaw-state-db-readonly.js"),
    import("../infra/kysely-sync.js"),
    import("../state/openclaw-state-db-schema-helpers.js"),
    import("../state/openclaw-state-db.paths.js"),
    import("../infra/update-run-reader.js"),
    import("../infra/sqlite-files.js"),
    import("../infra/sqlite-file-header.js"),
    import("../config/paths.js"),
  ]);
  const shared = paths.resolveOpenClawStateSqlitePath(env);
  if (!inspectPath(shared)?.isFile()) {
    refuse("the copied shared database is missing");
  }
  for (const companion of sqliteFiles.resolveSqliteDatabaseFilePaths(shared)) {
    inspectPath(companion);
  }
  await stateReader.withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
    ({ db }) => {
      const queries =
        sqlite.getNodeSqliteKysely<
          Pick<
            import("../state/openclaw-state-db.generated.js").DB,
            "state_leases" | "agent_database_leases"
          >
        >(db);
      for (const table of ["state_leases", "agent_database_leases"] as const) {
        if (
          schema.tableExists(db, table) &&
          sqlite.executeSqliteQueryTakeFirstSync(db, queries.selectFrom(table).selectAll().limit(1))
        ) {
          refuse("the copied shared database retains process leases");
        }
      }
    },
    { env },
  );
  const runs = runsApi.requireCompleteActiveUpdateRuns(
    await runsApi.listUpdateRunsAsync({ active: true, limit: 100 }, { env }),
  );
  const parents: Array<{
    child: number;
    identity: NonNullable<ReturnType<typeof driver.readUpdateRunDriver>>;
  }> = [];
  let child = process.pid;
  let matched = false;
  for (let depth = 0; depth < 4; depth++) {
    const pid = processTree.readProcessParentPidSync(child);
    const identity = pid === null ? undefined : driver.readUpdateRunDriver(pid);
    if (!identity) {
      break;
    }
    parents.push({ child, identity });
    const matches = runs.filter(
      (run) =>
        run.status === "running" &&
        run.origin.driver &&
        driver.sameUpdateRunDriver(run.origin.driver, identity),
    );
    const match = matches.length === 1 ? matches[0] : undefined;
    if (
      matches.length > 1 ||
      (match &&
        (!["2026.9.3", "2026.9.4"].includes(match.before.version ?? "") ||
          hasActiveUpdateDoctorStep(match)))
    ) {
      refuse("the observed parent has ambiguous or live Doctor ownership");
    }
    if (match) {
      matched = true;
      break;
    }
    child = identity.pid;
  }
  if (!matched) {
    refuse("the copied update record does not identify its observed legacy parent");
  }
  const snapshot = await readConfigFileSnapshot({
    observe: false,
    isolateEnv: true,
    pluginValidation: "skip",
  });
  if (snapshot.path !== configPath || snapshot.raw !== raw) {
    refuse("the copied configuration changed during inspection");
  }
  const config = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const registered = registryApi.inspectOpenClawRegisteredAgentDatabases({
    env,
    includeIncompatibleSchemaVersions: true,
  });
  const databases = [
    ...registered,
    ...targets.resolveConfiguredAgentDatabaseTargets(config, {
      env,
      registeredDatabases: registered,
    }),
  ];
  const resources = (
    await Promise.all([
      plugins.collectPluginDoctorMigrationBackupResources({
        config,
        env,
        stateDir,
        requireDeclaredResources: true,
      }),
      workshop.collectDoctorSkillWorkshopBackupResources({ config, env }),
    ])
  ).flat();
  const pendingPaths = [
    configPath,
    configPaths.resolveOAuthDir(env, stateDir),
    ...sqliteFiles.resolveSqliteDatabaseFilePaths(shared),
    path.join(stateDir, "workspace"),
    path.join(stateDir, "canary.log"),
    ...Object.values(config.agents?.entries ?? {}).flatMap((agent) =>
      [agent.workspace, agent.cwd, agent.agentDir].filter(
        (entry): entry is string => typeof entry === "string",
      ),
    ),
    ...[env.OPENCLAW_AGENT_DIR, env.PI_CODING_AGENT_DIR].filter(
      (entry): entry is string => typeof entry === "string",
    ),
    ...databases.flatMap((database) => sqliteFiles.resolveSqliteDatabaseFilePaths(database.path)),
    ...resources.flatMap((resource) =>
      resource.kind === "sqlite"
        ? sqliteFiles.resolveSqliteDatabaseFilePaths(resource.path)
        : [resource.path],
    ),
  ];
  const visited = new Set<string>();
  while (pendingPaths.length > 0) {
    const filename = pendingPaths.pop();
    if (filename === undefined) {
      break;
    }
    if (visited.has(filename)) {
      continue;
    }
    visited.add(filename);
    if (visited.size > 100_000) {
      refuse("the migration data inventory exceeds bounded inspection");
    }
    const stat = inspectPath(filename);
    if (stat?.isDirectory()) {
      pendingPaths.push(...(await fs.readdir(filename)).map((name) => path.join(filename, name)));
    } else if (stat?.isFile() && (await fileHeader.isSqliteSnapshotFile(filename))) {
      // Absent companions must still be rechecked after maintenance opens the copy.
      pendingPaths.push(...sqliteFiles.resolveSqliteDatabaseFilePaths(filename));
    }
  }
  const assertCurrent = () => {
    assertEnv();
    const current = lstatSync(stateDir);
    if (
      current.dev !== rootIdentity.dev ||
      current.ino !== rootIdentity.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (process.platform !== "win32" && (current.mode & 0o077) !== 0) ||
      current.uid !== rootIdentity.uid ||
      realpathSync(stateDir) !== stateDir
    ) {
      refuse("the admitted rehearsal root changed");
    }
    for (const parent of parents) {
      const identity = driver.readUpdateRunDriver(parent.identity.pid);
      if (
        processTree.readProcessParentPidSync(parent.child) !== parent.identity.pid ||
        !identity ||
        !driver.sameUpdateRunDriver(identity, parent.identity)
      ) {
        refuse("the admitted rehearsal parent changed");
      }
    }
  };
  const assertPrepared = () => {
    assertCurrent();
    for (const filename of identities.keys()) {
      if (!inspectPath(filename, filename === configPath)) {
        refuse(`copied data disappeared before admission: ${filename}`);
      }
    }
    for (const filename of visited) {
      inspectPath(filename, filename === configPath);
    }
    if (readFileSync(configPath, "utf8") !== raw) {
      refuse("the copied configuration changed before admission");
    }
  };
  assertPrepared();
  return {
    fact: {
      kind: "legacy-driver-rehearsal",
      driverStyle: "2026.9.3",
      message: admissionMessage,
      stateDir,
    },
    assertPrepared,
    assertCurrent,
  };
}

export async function prepareLegacyDoctorRehearsal(runtime: RuntimeEnv): Promise<
  | {
      maintenance: DoctorMaintenance;
      assertCurrent(this: void): void;
    }
  | undefined
> {
  const admitted = await inspectLegacyDoctorRehearsal();
  if (!admitted) {
    return undefined;
  }
  const { beginDoctorMaintenance } = await import("./doctor-maintenance.js");
  const maintenance = await beginDoctorMaintenance({
    root: null,
    options: { repair: true },
    runtime,
  });
  if (!maintenance) {
    refuse("copied-state maintenance ownership is unavailable");
  }
  try {
    admitted.assertPrepared();
    const assertCurrent = () => {
      maintenance.assertCurrent();
      admitted.assertCurrent();
    };
    assertCurrent();
    runtime.log(JSON.stringify(admitted.fact));
    runtime.error(`Warning: ${admitted.fact.message}`);
    return { maintenance, assertCurrent };
  } catch (error) {
    await maintenance.release();
    throw error;
  }
}
