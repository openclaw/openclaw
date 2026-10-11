import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createSourceRuntime,
  runIsolatedModuleScript,
} from "../../commands/doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const runtimeParent = fs.realpathSync(tempDirs.make("openclaw-selection-runtime-"));
const childTempDir = fs.realpathSync(tempDirs.make("openclaw-selection-tmp-"));

beforeEach(() => {
  // TSX keys transforms by source path. Reuse that path, but recreate package
  // assets after the previous child has joined; scenario state stays private.
  fs.rmSync(path.join(runtimeParent, "runtime"), { recursive: true, force: true });
});

function stateManifest(root: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filename = path.join(entry.parentPath, entry.name);
        return [
          path.relative(root, filename),
          createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        ];
      }),
  );
}

describe("Gateway config selection before migration admission", () => {
  it("accepts a Doctor-repaired escaped reference and refuses later config drift", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-startup-reference-repair-"));
    const runtimeRoot = createSourceRuntime(runtimeParent);
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);
    const configPath = path.join(stateDir, "openclaw.json");
    const apiKey = "$${STARTUP_MEMORY_KEY}";
    const original = JSON.stringify({
      agents: { defaults: { memorySearch: { remote: { apiKey } } } },
      gateway: { mode: "local" },
      plugins: { enabled: false },
    });
    fs.writeFileSync(configPath, original);
    const result = await runIsolatedModuleScript(
      {
        PATH: process.env.PATH,
        TMPDIR: childTempDir,
        TEMP: childTempDir,
        TMP: childTempDir,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
        STARTUP_MEMORY_KEY: "fixture-memory-key",
      },
      `
      import fs from "node:fs";
      const { selectGatewayRunEnvironment, prepareGatewayRunBootstrap, recheckGatewayRunBootstrap } = await import("./src/cli/gateway-cli/pre-bootstrap.ts");
      const { runDoctorConfigPreflight } = await import("./src/commands/doctor-config-preflight.ts");
      const { readConfigFileSnapshot } = await import("./src/config/config.ts");
      const { ExitError } = await import("./src/runtime.ts");
      const runtime = { log() {}, error: console.error, exit(code) { throw new ExitError(code); } };
      const params = { opts: {}, runtime };
      await runDoctorConfigPreflight({ repairPrefixedConfig: true, doctorOnlyStateMigrations: true });
      const repairedBytes = fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8");
      if (!await selectGatewayRunEnvironment(params)) throw new Error("selection refused");
      if (!await prepareGatewayRunBootstrap(params)) throw new Error("preparation refused");
      const admitted = await recheckGatewayRunBootstrap(params);
      const selected = await readConfigFileSnapshot();
      const selectedBytes = fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8");
      const raw = JSON.parse(selectedBytes);
      raw.gateway.mode = "remote";
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(raw));
      let driftRefused = false;
      try {
        await recheckGatewayRunBootstrap(params);
      } catch (error) {
        if (!(error instanceof ExitError)) throw error;
        driftRefused = error.code === 1;
      }
      console.log("__RESULT__" + JSON.stringify({
        admitted, driftRefused,
        configUnchanged: selectedBytes === repairedBytes,
        apiKey: selected.sourceConfig.memory.search.remote.apiKey,
        authoredApiKey: raw.memory.search.remote.apiKey,
      }));
      `,
      { runtimeRoot, timeoutMs: 60_000 },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("__RESULT__"));
    expect(line, output).toBeDefined();
    expect(JSON.parse(line!.slice("__RESULT__".length)), output).toEqual({
      admitted: true,
      driftRefused: true,
      configUnchanged: true,
      apiKey: "${STARTUP_MEMORY_KEY}",
      authoredApiKey: apiKey,
    });
    expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(original);
  }, 75_000);

  it.each([
    { name: "managed template", apiKey: "${REPRO_PROVIDER_KEY}", managed: true, included: false },
    {
      name: "unmanaged template",
      apiKey: "${REPRO_PROVIDER_KEY}",
      managed: false,
      included: false,
    },
    { name: "included template", apiKey: "${REPRO_PROVIDER_KEY}", managed: true, included: true },
    { name: "managed shorthand", apiKey: "$REPRO_PROVIDER_KEY", managed: true, included: false },
    {
      name: "managed object",
      apiKey: { source: "env", provider: "default", id: "REPRO_PROVIDER_KEY" },
      managed: true,
      included: false,
    },
    {
      name: "managed auth-profile-only reference",
      apiKey: undefined,
      managed: true,
      included: false,
      authProfile: true,
    },
    {
      name: "managed unreadable secondary",
      apiKey: undefined,
      managed: true,
      included: false,
      authProfile: true,
      unreadableAuth: true,
    },
    {
      name: "managed reset with unreadable secondary",
      apiKey: undefined,
      managed: true,
      included: false,
      authProfile: true,
      unreadableAuth: true,
      reset: true,
    },
    ...(["ownership", "credentials"] as const).map((cleanupStage) => ({
      name: `managed shared ${cleanupStage} cleanup failure`,
      apiKey: undefined,
      managed: true,
      included: false,
      authProfile: true,
      cleanupStage,
    })),
    {
      name: "managed config env replacement",
      apiKey: undefined,
      managed: true,
      included: false,
      configEnv: true,
    },
  ])(
    "preserves $name through startup without writing config",
    async (scenario) => {
      const { apiKey, managed, included } = scenario;
      const authProfile = "authProfile" in scenario && scenario.authProfile;
      const configEnv = "configEnv" in scenario && scenario.configEnv;
      const unreadableAuth = "unreadableAuth" in scenario && scenario.unreadableAuth;
      const reset = "reset" in scenario && scenario.reset;
      const cleanupStage = "cleanupStage" in scenario ? scenario.cleanupStage : undefined;
      const root = fs.realpathSync(tempDirs.make("openclaw-managed-env-selection-"));
      const runtimeRoot = createSourceRuntime(runtimeParent);
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      const providers = {
        minimax: {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages",
          apiKey,
          models: [],
        },
      };
      if (included) {
        fs.writeFileSync(path.join(stateDir, "providers.json"), JSON.stringify(providers));
      }
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { mode: "local" },
          plugins: { enabled: false },
          messages: { responsePrefix: "$${STALE_KEY}" },
          models: { providers: included ? { $include: "providers.json" } : providers },
          ...(configEnv ? { env: { vars: { REPRO_PROVIDER_KEY: "repro-not-a-real-key" } } } : {}),
          ...(reset ? { env: { vars: { RESET_ONLY_KEY: "synthetic-authored-reset-value" } } } : {}),
          ...(authProfile
            ? {
                agents: {
                  ownership: "explicit",
                  entries: { main: {}, helper: {}, ...(unreadableAuth ? { broken: {} } : {}) },
                },
                auth: { profiles: { "minimax:fixture": { provider: "minimax", mode: "api_key" } } },
              }
            : {}),
        }),
      );
      const before = stateManifest(stateDir);
      const configBefore = fs.readFileSync(configPath, "utf8");
      const result = await runIsolatedModuleScript(
        {
          PATH: process.env.PATH,
          TMPDIR: childTempDir,
          TEMP: childTempDir,
          TMP: childTempDir,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          XDG_CACHE_HOME: path.join(root, "cache"),
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
          INVOCATION_ID: "repro",
          REPRO_PROVIDER_KEY: configEnv ? "stale-inherited-key" : "repro-not-a-real-key",
          STALE_KEY: "removed-service-value",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: managed ? "REPRO_PROVIDER_KEY,STALE_KEY" : "STALE_KEY",
        },
        `
        import fs from "node:fs";
        import path from "node:path";
        import { createHash } from "node:crypto";
        Object.defineProperty(process, "platform", { value: "linux" });
        const authProfile = ${JSON.stringify(authProfile)};
        const unreadableAuth = ${JSON.stringify(unreadableAuth)};
        const reset = ${JSON.stringify(reset)};
        const cleanupStage = ${JSON.stringify(cleanupStage)};
        let stateBefore;
        let profileRef;
        let agentDir;
        if (authProfile) {
          if (cleanupStage) {
            const { writeConfigMachineState } = await import("./src/state/config-machine-state-write.ts");
            writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: process.env });
          }
          const { saveAuthProfileStore } = await import("./src/agents/auth-profiles/store-runtime.ts");
          const { loadPersistedAuthProfileStore } = await import("./src/agents/auth-profiles/persisted.ts");
          const { resolveSecretRefString } = await import("./src/secrets/resolve.ts");
          const { closeOpenClawAgentDatabasesAsync } = await import("./src/state/openclaw-agent-db.ts");
          const { closeOpenClawStateDatabaseAsync } = await import("./src/state/openclaw-state-db.ts");
          const { closeAuthProfileReadPool } = await import("./src/agents/auth-profiles/sqlite.ts");
          agentDir = path.join(process.env.OPENCLAW_STATE_DIR, "agents", "helper", "agent");
          fs.mkdirSync(agentDir, { recursive: true });
          saveAuthProfileStore({ version: 1, profiles: { "minimax:fixture": {
            type: "api_key", provider: "minimax",
            keyRef: { source: "env", provider: "default", id: "REPRO_PROVIDER_KEY" },
          } } }, agentDir);
          profileRef = loadPersistedAuthProfileStore(agentDir)?.profiles["minimax:fixture"]?.keyRef;
          if (!profileRef || !fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))) {
            throw new Error("SQLite auth-profile fixture was not persisted");
          }
          if (await resolveSecretRefString(profileRef, { config: {}, env: process.env }) !== "repro-not-a-real-key") {
            throw new Error("Auth-profile fixture did not resolve before startup");
          }
          if (cleanupStage) {
            const { writePersistedAuthProfileStoreRaw } = await import("./src/agents/auth-profiles/sqlite.ts");
            const { openOpenClawStateDatabase } = await import("./src/state/openclaw-state-db.ts");
            writePersistedAuthProfileStoreRaw({ version: 1, profiles: {
              shared: { type: "api_key", provider: "fixture", keyRef: profileRef },
              inline: { type: "api_key", provider: "fixture", key: "synthetic-private-copy-credential" },
            } }, undefined, openOpenClawStateDatabase({ env: process.env }));
          }
          let brokenPath;
          if (unreadableAuth) {
            const brokenDir = path.join(process.env.OPENCLAW_STATE_DIR, "agents", "broken", "agent");
            saveAuthProfileStore({ version: 1, profiles: {} }, brokenDir);
            brokenPath = path.join(brokenDir, "openclaw-agent.sqlite");
          }
          closeAuthProfileReadPool({ kind: "root", rootPath: process.env.OPENCLAW_STATE_DIR });
          await closeOpenClawAgentDatabasesAsync(process.env.OPENCLAW_STATE_DIR);
          await closeOpenClawStateDatabaseAsync();
          if (brokenPath) fs.writeFileSync(brokenPath, "synthetic invalid secondary SQLite");
          stateBefore = Object.fromEntries(fs.readdirSync(process.env.OPENCLAW_STATE_DIR, {
            recursive: true, withFileTypes: true,
          }).filter(entry => entry.isFile()).map(entry => {
            const filename = path.join(entry.parentPath, entry.name);
            return [path.relative(process.env.OPENCLAW_STATE_DIR, filename),
              createHash("sha256").update(fs.readFileSync(filename)).digest("hex")];
          }));
        }
        const { selectGatewayRunEnvironment, prepareGatewayRunBootstrap, recheckGatewayRunBootstrap, recheckGatewayRunReset } = await import("./src/cli/gateway-cli/pre-bootstrap.ts");
        const { ExitError } = await import("./src/runtime.ts");
        if (authProfile) {
          const { readConfigFileSnapshot } = await import("./src/config/config.ts");
          const snapshot = await readConfigFileSnapshot({ isolateEnv: true, observe: false, pluginValidation: "core-only" });
          if (!snapshot.valid) throw new Error("Auth-profile fixture config was invalid: " + JSON.stringify(snapshot.issues));
        }
        const warnings = [];
        const runtime = { log() {}, error(message) { warnings.push(message); }, exit(code) { throw new ExitError(code); } };
        const opts = reset ? { reset: true, dev: true } : {};
        let admitted = false;
        let cleanupFailure;
        let failedCopy;
        let failedRemoval = false;
        let snapshotRetained = false;
        let credentialRetained = false;
        let cleanupJoined = false;
        const nativeRm = fs.rmSync;
        const { DatabaseSync } = await import("node:sqlite");
        const nativePrepare = DatabaseSync.prototype.prepare;
        if (cleanupStage) {
          const stateKey = cleanupStage === "ownership" ? "auth.sharedStore" : "authProfiles.store";
          // Observe the real selected row; only its private copy's filesystem removal fails.
          DatabaseSync.prototype.prepare = function(...args) {
            const statement = nativePrepare.apply(this, args);
            const location = this.location();
            for (const method of ["get", "all"]) {
              const query = statement[method];
              statement[method] = function(...bindings) {
                const result = query.apply(this, bindings);
                if (!failedCopy && bindings.includes(stateKey) && location &&
                    !location.startsWith(process.env.OPENCLAW_STATE_DIR + path.sep)) {
                  failedCopy = location;
                }
                return result;
              };
            }
            return statement;
          };
          fs.rmSync = function(target, options) {
            if (failedCopy && (String(target) === failedCopy || String(target) === path.dirname(failedCopy))) {
              failedRemoval = true;
              throw Object.assign(new Error("synthetic private snapshot removal refused"), { code: "EACCES" });
            }
            return nativeRm(target, options);
          };
        }
        try {
          const selected = await selectGatewayRunEnvironment({ opts, runtime });
          if (cleanupStage) {
            admitted = selected;
          } else {
            const bootstrap = selected && await prepareGatewayRunBootstrap({ opts, runtime });
            admitted = reset
              ? selected && !bootstrap && await recheckGatewayRunReset({ opts, runtime })
              : bootstrap && await recheckGatewayRunBootstrap({ opts, runtime });
          }
        } catch (error) {
          if (cleanupStage) cleanupFailure = error;
          else if (!(error instanceof ExitError)) throw error;
        } finally {
          try {
            if (cleanupStage) {
              snapshotRetained = Boolean(failedCopy && fs.existsSync(failedCopy));
              credentialRetained = snapshotRetained && fs.readFileSync(failedCopy).includes(Buffer.from("synthetic-private-copy-credential"));
            }
          } finally {
            DatabaseSync.prototype.prepare = nativePrepare;
            fs.rmSync = nativeRm;
          }
          if (cleanupStage) {
            const { closeOpenClawAgentDatabasesAsync } = await import("./src/state/openclaw-agent-db.ts");
            const { closeOpenClawStateDatabaseAsync } = await import("./src/state/openclaw-state-db.ts");
            const { cleanupSnapshotOperations } = await import("./src/infra/sqlite-readonly-location-cleanup.ts");
            const cleanupErrors = [];
            for (const close of [
              () => closeOpenClawAgentDatabasesAsync(process.env.OPENCLAW_STATE_DIR),
              () => closeOpenClawStateDatabaseAsync(),
              () => cleanupSnapshotOperations(),
            ]) {
              try { await close(); } catch (error) { cleanupErrors.push(error); }
            }
            if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Bootstrap fixture cleanup failed");
            cleanupJoined = Boolean(failedCopy && !fs.existsSync(path.dirname(failedCopy)));
          }
        }
        let cleanupRefused = false;
        if (cleanupStage) {
          const pending = [cleanupFailure];
          const visited = new Set();
          while (pending.length) {
            const error = pending.pop();
            if (!(error instanceof Error) || visited.has(error)) continue;
            visited.add(error);
            if (error.message === "Shared-state snapshot cleanup is incomplete.") cleanupRefused = true;
            if (error.cause) pending.push(error.cause);
            if (error instanceof AggregateError) pending.push(...error.errors);
          }
        }
        let resolved = false;
        let resolutionError;
        if (authProfile) {
          const { loadPersistedAuthProfileStoreAtDatabasePath } = await import("./src/agents/auth-profiles/persisted.ts");
          const { prepareSqliteReadOnlyLocationSync } = await import("./src/infra/sqlite-snapshot-source.ts");
          const { resolveSecretRefString } = await import("./src/secrets/resolve.ts");
          const source = prepareSqliteReadOnlyLocationSync(path.join(agentDir, "openclaw-agent.sqlite"));
          let persistedRef;
          try {
            persistedRef = loadPersistedAuthProfileStoreAtDatabasePath(source.location, "agent")?.profiles["minimax:fixture"]?.keyRef;
          } finally {
            const { closeAuthProfileReadPool } = await import("./src/agents/auth-profiles/sqlite.ts");
            closeAuthProfileReadPool({ kind: "database", databasePath: source.location });
            if (!source.cleanup()) throw new Error("Auth-profile verification snapshot cleanup failed");
          }
          if (JSON.stringify(persistedRef) !== JSON.stringify(profileRef)) {
            throw new Error("Startup changed the auth-profile reference");
          }
          try {
            resolved = await resolveSecretRefString(persistedRef, { config: {}, env: process.env }) === "repro-not-a-real-key";
          } catch (error) {
            if (error?.code !== "SECRET_REF_NOT_FOUND") throw error;
            resolutionError = error.code;
          }
          const { closeAuthProfileReadPool } = await import("./src/agents/auth-profiles/sqlite.ts");
          closeAuthProfileReadPool({ kind: "root", rootPath: process.env.OPENCLAW_STATE_DIR });
        }
        console.log("__RESULT__" + JSON.stringify({ admitted,
          keyPresent: process.env.REPRO_PROVIDER_KEY === "repro-not-a-real-key",
          stalePresent: process.env.STALE_KEY !== undefined,
          ...(authProfile ? { stateBefore, resolved, resolutionError } : {}),
          ...(cleanupStage ? {
            refused: cleanupRefused, failedRemoval, snapshotRetained, credentialRetained, cleanupJoined,
          } : {}),
          ...(unreadableAuth ? {
            warned: warnings.some(message => message.includes("auth-profile") && message.includes("doctor")),
            credentialSafe: warnings.every(message => ["repro-not-a-real-key", "removed-service-value", "REPRO_PROVIDER_KEY", "STALE_KEY", process.env.OPENCLAW_STATE_DIR, agentDir].every(value => !message.includes(value))),
            resetOnlyPresent: process.env.RESET_ONLY_KEY !== undefined,
          } : {}),
        }));
        `,
        { runtimeRoot, timeoutMs: 60_000 },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const line = result.stdout.split("\n").find((entry) => entry.startsWith("__RESULT__"));
      expect(line, output).toBeDefined();
      const { stateBefore, ...observed } = JSON.parse(line!.slice("__RESULT__".length));
      expect(observed, output).toEqual({
        admitted: !cleanupStage,
        keyPresent: true,
        stalePresent: Boolean(unreadableAuth || cleanupStage),
        ...(authProfile ? { resolved: true } : {}),
        ...(cleanupStage
          ? {
              refused: true,
              failedRemoval: true,
              snapshotRetained: true,
              credentialRetained: true,
              cleanupJoined: true,
            }
          : {}),
        ...(unreadableAuth
          ? { warned: !reset, credentialSafe: true, resetOnlyPresent: false }
          : {}),
      });
      expect(stateManifest(stateDir)).toEqual(authProfile ? stateBefore : before);
      expect(fs.readFileSync(configPath, "utf8")).toBe(configBefore);
    },
    75_000,
  );

  it.each([
    { name: "future backup before reset", code: 1 },
    { name: "future current config", code: 1 },
    { name: "future service-mode backup", code: 78 },
    { name: "future backup after config selection changes", code: 1 },
    { name: "discarded clobbered environment", code: 0 },
  ])(
    "prepares recovery safely for $name",
    async ({ name, code }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-recovery-selection-"));
      const runtimeRoot = createSourceRuntime(runtimeParent);
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      const healthy = {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        meta: { lastTouchedVersion: "1.0.0" },
      };
      const future = { ...healthy, meta: { lastTouchedVersion: "9999.1.1" } };
      const clobbered = { update: { channel: "stable" } };
      let current: Record<string, unknown> = clobbered;
      let backup: Record<string, unknown> = future;
      if (name === "future current config") {
        current = future;
        backup = healthy;
      } else if (name === "future service-mode backup") {
        backup = { ...future, env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } } };
      } else if (name === "future backup after config selection changes") {
        const selectedPath = path.join(stateDir, "selected.json");
        backup = { ...healthy, env: { vars: { OPENCLAW_CONFIG_PATH: selectedPath } } };
        fs.writeFileSync(selectedPath, JSON.stringify(clobbered));
        fs.writeFileSync(`${selectedPath}.bak`, JSON.stringify(future));
      } else if (name === "discarded clobbered environment") {
        current = {
          gateway: { mode: "local" },
          env: { vars: { OPENCLAW_GATEWAY_TOKEN: "discarded-test-token" } },
        };
        backup = healthy;
      }
      fs.writeFileSync(configPath, JSON.stringify(current));
      fs.writeFileSync(`${configPath}.bak`, JSON.stringify(backup));
      const before = stateManifest(stateDir);
      const result = await runIsolatedModuleScript(
        {
          ...process.env,
          TMPDIR: childTempDir,
          TEMP: childTempDir,
          TMP: childTempDir,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
          OPENCLAW_SERVICE_MARKER: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_PROXY_ACTIVE: "1",
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS:
            name === "future service-mode backup" ? "1" : undefined,
        },
        `
        const { selectGatewayRunEnvironment } = await import("./src/cli/gateway-cli/pre-bootstrap.ts");
        const { ExitError } = await import("./src/runtime.ts");
        let code = 0;
        try {
          await selectGatewayRunEnvironment({
            opts: ${JSON.stringify(name === "future backup before reset" ? { dev: true, reset: true } : {})},
            runtime: { log() {}, error: console.error, exit(code) { throw new ExitError(code); } },
          });
        } catch (error) {
          if (!(error instanceof ExitError)) throw error;
          code = error.code;
        }
        process.stdout.write("__RESULT__" + JSON.stringify({ code,
          tokenPresent: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN),
          proxyRetained: process.env.OPENCLAW_PROXY_ACTIVE === "1",
        }) + "\\n");
      `,
        { runtimeRoot, timeoutMs: 60_000 },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const line = result.stdout.split("\n").find((entry) => entry.startsWith("__RESULT__"));
      expect(line, output).toBeDefined();
      expect(JSON.parse(line!.slice("__RESULT__".length)), output).toEqual({
        code,
        tokenPresent: false,
        proxyRetained: true,
      });
      expect(stateManifest(stateDir)).toEqual(before);
    },
    75_000,
  );

  it.each([false, true])(
    "preserves every state artifact with backup=%s",
    async (withBackup) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-readonly-bootstrap-"));
      const runtimeRoot = createSourceRuntime(runtimeParent);
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { mode: "local" },
          meta: { lastTouchedAt: "2026-02-15T00:00:00.000Z" },
          agents: { entries: { main: {}, helper: {} } },
          plugins: {
            enabled: false,
            installs: { example: { source: "path", installPath: path.join(root, "plugin") } },
          },
        }),
      );
      if (withBackup) {
        fs.writeFileSync(
          `${configPath}.bak`,
          JSON.stringify({
            gateway: { mode: "local" },
            agents: { defaults: { workspace: path.join(root, "workspace") } },
            messages: { ackReaction: "synthetic long-lived config baseline" },
            plugins: {
              enabled: false,
              installs: { example: { source: "path", installPath: path.join(root, "plugin") } },
            },
          }),
        );
      }
      const before = stateManifest(stateDir);
      const env = {
        ...process.env,
        TMPDIR: childTempDir,
        TEMP: childTempDir,
        TMP: childTempDir,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
        OPENCLAW_TEST_FAST: "1",
      };
      const result = await runIsolatedModuleScript(
        env,
        `
      const { selectGatewayRunEnvironment, prepareGatewayRunBootstrap } = await import("./src/cli/gateway-cli/pre-bootstrap.ts");
      const runtime = { log() {}, error() {}, exit(code) { throw new Error("unexpected exit " + code); } };
      if (!await selectGatewayRunEnvironment({ opts: {}, runtime })) throw new Error("selection refused");
      if (!await prepareGatewayRunBootstrap({ opts: {}, runtime })) throw new Error("preparation refused");
      console.log("prepared");
    `,
        { runtimeRoot, timeoutMs: 60_000 },
      );
      expect(result.stdout).toContain("prepared");
      expect(stateManifest(stateDir)).toEqual(before);
    },
    90_000,
  );

  it.each([
    {
      flag: "--allow-unconfigured",
      dispatch: "fast",
      suffix: [],
      dev: false,
      allowUnconfigured: true,
    },
    {
      flag: "--allow-unconfigured",
      dispatch: "Commander",
      suffix: ["--"],
      dev: false,
      allowUnconfigured: true,
    },
    { flag: "--dev", dispatch: "fast", suffix: [], dev: true, allowUnconfigured: false },
    { flag: "--dev", dispatch: "Commander", suffix: ["--"], dev: true, allowUnconfigured: false },
  ])(
    "passes $flag through $dispatch startup admission without config",
    async ({ flag, suffix, dev, allowUnconfigured }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-startup-allowance-"));
      const runtimeRoot = createSourceRuntime(runtimeParent);
      const stateDir = path.join(root, "state");
      fs.mkdirSync(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
        OPENCLAW_HIDE_BANNER: "1",
        OPENCLAW_GATEWAY_TOKEN: "synthetic-startup-allowance-token",
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
        XDG_DATA_HOME: path.join(root, "xdg-data"),
        XDG_STATE_HOME: path.join(root, "xdg-state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"),
        TMPDIR: childTempDir,
        TEMP: childTempDir,
        TMP: childTempDir,
        NO_COLOR: "1",
      };
      // Keep parsing, environment selection, preaction, and config admission real.
      // Replace only the final Gateway action; the built rig proves listener startup.
      const result = await runIsolatedModuleScript(
        env,
        `
      import { registerHooks } from "node:module";
      const calls = globalThis[Symbol.for("openclaw.test.startupAllowanceCalls")] = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const parent = context.parentURL ?? "";
          if (specifier === "./run.js" &&
              (parent.endsWith("/cli/gateway-cli/run-command.ts") || parent.endsWith("/cli/gateway-cli/run-command.js"))) {
            return {
              shortCircuit: true,
              url: "data:text/javascript," + encodeURIComponent(
                'export async function runGatewayCommand(opts) {' +
                'globalThis[Symbol.for("openclaw.test.startupAllowanceCalls")].push({' +
                'dev: opts.dev === true, allowUnconfigured: opts.allowUnconfigured === true }); }'
              ),
            };
          }
          return nextResolve(specifier, context);
        },
      });
      const { runCli } = await import("./src/cli/run-main.ts");
      process.argv = [process.execPath, "openclaw", "gateway", "run", "--port", "18736", ${JSON.stringify(flag)}, ...${JSON.stringify(suffix)}];
      await runCli(process.argv);
      process.stdout.write("__RESULT__" + JSON.stringify(calls) + "\\n");
    `,
        { runtimeRoot, timeoutMs: 60_000 },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const results = result.stdout.split("\n").filter((line) => line.startsWith("__RESULT__"));
      expect(results, output).toHaveLength(1);
      expect(JSON.parse(results[0]!.slice("__RESULT__".length))).toEqual([
        { dev, allowUnconfigured },
      ]);
      expect(fs.existsSync(configPath)).toBe(false);
    },
    75_000,
  );
});
