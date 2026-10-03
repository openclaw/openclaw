import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as runtimeGuard from "../../infra/runtime-guard.js";
import {
  isUpdateAdmissionAuthorityEnvKey,
  type UpdateAdmissionContext,
} from "../../infra/update-admission-contract.js";
import {
  parseUpdateAdmissionVerdict,
  type UpdateAdmissionVerdict,
} from "../../infra/update-run-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { runCli } from "../run-main.js";
import { registerUpdateCli } from "../update-cli.js";
import * as schemaPreflight from "./schema-preflight.js";
import { updateAdmitCommand } from "./update-command-admit.js";
import * as pluginPreflight from "./update-command-plugin-preflight.js";

const forbidden = vi.hoisted(() => ({
  lease: vi.fn(() => {
    throw new Error("Admission acquired an executor");
  }),
  ledger: vi.fn(() => {
    throw new Error("Admission created update history");
  }),
}));
vi.mock("./update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-executor.js")>()),
  withUpdateCommandExecutor: forbidden.lease,
}));
vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  createUpdateRun: forbidden.ledger,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const previousExitCode = process.exitCode;
let home: string;
let root: string;
let configPath: string;
let contextPath: string;
let context: UpdateAdmissionContext;
let stdout: string;
let stderr: string;

function writeConfig(value: unknown) {
  fs.writeFileSync(configPath, JSON.stringify(value));
}

function readVerdict(): UpdateAdmissionVerdict {
  const verdict = parseUpdateAdmissionVerdict(JSON.parse(stdout));
  expect(verdict).not.toBeNull();
  return verdict!;
}

function snapshotFiles() {
  return fs
    .readdirSync(home, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filename = path.join(entry.parentPath, entry.name);
      return [
        path.relative(home, filename),
        fs.readFileSync(filename).toString("hex"),
        fs.statSync(filename).mode,
      ];
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr += args.join(" ");
  });
  home = dirs.make("candidate-admission-");
  root = path.join(home, "prefix", "lib", "node_modules", "openclaw");
  const stateDir = path.join(home, "profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(stateDir);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
  );
  configPath = path.join(stateDir, "openclaw.json");
  contextPath = path.join(home, "context.json");
  context = {
    protocol: 1,
    installation: {
      root,
      canonicalRoot: fs.realpathSync(root),
      version: "2026.9.0",
      installKind: "package",
      packageManager: "npm",
    },
    target: { spec: "openclaw@latest", version: null, source: "registry", channel: "stable" },
    request: { yes: true, noRestart: true, acceptCapabilities: false, json: true },
    run: { id: "candidate-admission-fixture" },
    supervisor: { version: "2026.9.1", host: "fixture", pid: process.pid },
  };
  for (const key of Object.keys(process.env)) {
    if (isUpdateAdmissionAuthorityEnvKey(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_OAUTH_DIR: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  })) {
    vi.stubEnv(key, value);
  }
  writeConfig({});
  fs.writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 });
});

afterEach(() => {
  expect(forbidden.lease).not.toHaveBeenCalled();
  expect(forbidden.ledger).not.toHaveBeenCalled();
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("candidate update admission", () => {
  it.each([
    "cron/runs",
    "delivery-queue",
    "session-delivery-queue/failed",
    "credentials/auth-profiles",
  ])("refuses a dangling %s directory link before activation", async (relative) => {
    const sourcePath = path.join(path.dirname(configPath), relative);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.symlinkSync(path.join(home, "missing-history"), sourcePath, "junction");
    const originalTarget = fs.readlinkSync(sourcePath);
    const before = snapshotFiles();

    await updateAdmitCommand(contextPath);

    expect(process.exitCode).toBe(3);
    expect(readVerdict()).toMatchObject({
      verdict: "refuse",
      reasons: [expect.objectContaining({ code: "retired-state-format" })],
    });
    expect(stderr).toBe("");
    expect(snapshotFiles()).toEqual(before);
    expect(fs.readlinkSync(sourcePath)).toBe(originalTarget);
  });

  it.each([
    "cron/runs",
    "delivery-queue",
    "session-delivery-queue/failed",
    "credentials/auth-profiles",
  ])(
    "refuses an uninspectable %s path instead of permitting admission fallback",
    async (relative) => {
      const sourcePath = path.join(path.dirname(configPath), relative);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "retained operator data\n");
      const before = snapshotFiles();

      await updateAdmitCommand(contextPath);

      expect(process.exitCode).toBe(3);
      expect(readVerdict()).toMatchObject({
        verdict: "refuse",
        reasons: [
          expect.objectContaining({
            code: "retired-state-format",
            message: expect.stringContaining("Cannot inspect potentially retired state"),
          }),
        ],
      });
      expect(stderr).toBe("");
      expect(snapshotFiles()).toEqual(before);
    },
  );

  it.each([
    "cron/jobs.json",
    "cron/jobs-state.json",
    "cron/runs/retained.jsonl",
    "custom-cron/jobs.json",
    "delivery-queue/pending.json",
    "delivery-queue/failed/failed.json",
    "session-delivery-queue/pending.json",
    "session-delivery-queue/failed/failed.json",
    "delivery-queue/sent.delivered",
    "plugins/installs.json",
    `credentials/auth-profiles/${"b".repeat(32)}.json`,
  ])(
    "refuses retired %s before a published updater can activate the candidate",
    async (relative) => {
      const stateDir = path.dirname(configPath);
      const custom = relative.startsWith("custom-cron/");
      const filename = path.join(custom ? home : stateDir, relative);
      if (custom) {
        writeConfig({ cron: { store: filename } });
      }
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, "retained operator data\n");
      const before = snapshotFiles();

      await updateAdmitCommand(contextPath);

      expect(process.exitCode).toBe(3);
      expect(readVerdict()).toMatchObject({
        verdict: "refuse",
        reasons: [
          expect.objectContaining({
            code: "retired-state-format",
            message: expect.stringContaining("Upgrade through OpenClaw 2026.9.7"),
          }),
        ],
        facts: {
          checks: expect.arrayContaining([
            { name: "state-format", status: "refuse", detail: expect.any(String) },
          ]),
        },
      });
      expect(stderr).toBe("");
      expect(snapshotFiles()).toEqual(before);
      expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
    },
  );

  it.each(["environment", "config", "prefixed-config", "prefixed-include"])(
    "refuses retired OAuth selected by %s without changing the live profile",
    async (selector) => {
      const oauthDir = path.join(home, "external-auth");
      const selected = { env: { vars: { OPENCLAW_OAUTH_DIR: "~/external-auth" } } };
      if (selector === "environment") {
        vi.stubEnv("OPENCLAW_OAUTH_DIR", oauthDir);
      } else if (selector === "prefixed-include") {
        fs.writeFileSync(
          path.join(path.dirname(configPath), "auth-selector.json"),
          JSON.stringify(selected),
        );
        fs.writeFileSync(configPath, 'unexpected prefix\n{"$include":"auth-selector.json"}');
      } else {
        fs.writeFileSync(
          configPath,
          `${selector === "prefixed-config" ? "unexpected prefix\n" : ""}${JSON.stringify(selected)}`,
        );
      }
      fs.writeFileSync(`${configPath}.bak`, "{}\n");
      const sidecar = path.join(oauthDir, "auth-profiles", `${"a".repeat(32)}.json`);
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
      fs.writeFileSync(sidecar, "unparsed retired credential bytes\n", { mode: 0o600 });
      const before = snapshotFiles();

      await updateAdmitCommand(contextPath);

      expect(process.exitCode).toBe(3);
      expect(readVerdict()).toMatchObject({
        verdict: "refuse",
        reasons: [
          expect.objectContaining({
            code: "retired-state-format",
            message: expect.stringContaining("Upgrade through OpenClaw 2026.9.7"),
          }),
        ],
        facts: {
          checks: expect.arrayContaining([
            { name: "state-format", status: "refuse", detail: expect.any(String) },
          ]),
        },
      });
      expect(stderr).toBe("");
      expect(snapshotFiles()).toEqual(before);
      expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
    },
  );

  it("uses the explicit installed root and emits one JSON verdict without creating live state", async () => {
    const before = snapshotFiles();
    const program = new Command().name("openclaw");
    registerUpdateCli(program);
    expect(
      program.commands.find((command) => command.name() === "update")!.helpInformation(),
    ).not.toContain("admit");
    await program.parseAsync(["node", "openclaw", "update", "admit", "--context", contextPath]);
    expect(readVerdict()).toMatchObject({
      verdict: "admit",
      reasons: [],
      facts: {
        installedVersion: "2026.9.1",
        checks: [
          { name: "config", status: "ok" },
          { name: "database-schema", status: "ok" },
          { name: "node-runtime", status: "ok" },
          { name: "plugin-availability", status: "ok" },
        ],
      },
    });
    expect(process.exitCode).toBe(0);
    expect(snapshotFiles()).toEqual(before);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
  });

  it("admits a missing custom plugin path without changing profile artifacts with an idle WAL", async () => {
    const customAgentPath = path.join(home, "custom-agent.sqlite");
    writeConfig({
      session: { store: customAgentPath },
      plugins: { load: { paths: [path.join(home, "missing-custom-plugin")] } },
    });
    const databasePath = resolveOpenClawStateSqlitePath();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    const agentDatabases: DatabaseSync[] = [];
    try {
      database.exec(
        fs.readFileSync(new URL("../../state/openclaw-state-schema.sql", import.meta.url), "utf8"),
      );
      database.exec(`PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION}`);
      database
        .prepare("INSERT INTO schema_meta VALUES ('primary','global',?,NULL,?,1,1)")
        .run(OPENCLAW_STATE_SCHEMA_VERSION, context.supervisor.version);
      const registeredAgentPath = path.join(path.dirname(configPath), "registered-agent.sqlite");
      database
        .prepare("INSERT INTO agent_databases VALUES ('registered',?,?,1,NULL)")
        .run(registeredAgentPath, OPENCLAW_AGENT_SCHEMA_VERSION);
      // Cover on-disk discovery, configured stores, and registry-only stores together.
      for (const [agentPath, keepWal] of [
        [path.join(path.dirname(configPath), "agents/main/agent/openclaw-agent.sqlite"), true],
        [path.join(path.dirname(configPath), "agents/offline/agent/openclaw-agent.sqlite"), false],
        [customAgentPath, true],
        [registeredAgentPath, true],
      ] as const) {
        fs.mkdirSync(path.dirname(agentPath), { recursive: true });
        const agent = new DatabaseSync(agentPath);
        agentDatabases.push(agent);
        agent.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
        agent.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION}`);
        if (!keepWal) {
          agent.close();
        }
        for (const suffix of ["-wal", "-shm"]) {
          expect(fs.existsSync(agentPath + suffix)).toBe(keepWal);
        }
      }
      // Keep a committed WAL without a concurrent writer so any byte change belongs to admission.
      database.exec(
        "PRAGMA journal_mode=WAL; INSERT INTO config_machine_state VALUES ('admission-fixture','{}',1)",
      );
      const before = snapshotFiles();
      await runCli([
        "node",
        "openclaw",
        "--profile",
        "admission-fixture",
        "update",
        "admit",
        "--context",
        contextPath,
      ]);
      expect(readVerdict()).toMatchObject({
        verdict: "admit",
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "configured-plugin-path-unavailable" }),
        ]),
        facts: { checks: expect.arrayContaining([{ name: "config", status: "warn" }]) },
      });
      expect(process.exitCode).toBe(0);
      expect(snapshotFiles()).toEqual(before);

      // A newer header committed only in WAL must still refuse admission.
      agentDatabases[0]!.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
      const beforeRefusal = snapshotFiles();
      stdout = "";
      await runCli(["node", "openclaw", "update", "admit", "--context", contextPath]);
      expect(readVerdict()).toMatchObject({
        verdict: "refuse",
        reasons: [expect.objectContaining({ code: "database-schema-preflight" })],
      });
      expect(process.exitCode).toBe(3);
      expect(snapshotFiles()).toEqual(beforeRefusal);
    } finally {
      for (const agent of agentDatabases) {
        if (agent.isOpen) {
          agent.close();
        }
      }
      database.close();
    }
  });

  it.each([
    {
      kind: "invalid value",
      config: { gateway: { port: "private-invalid-value" } },
      nextAction: /openclaw doctor --fix/,
    },
    {
      kind: "retired format",
      config: { heartbeat: { every: "private-invalid-value" } },
      nextAction: /Install OpenClaw 2026\.9\.5[\s\S]*openclaw doctor --fix/,
    },
  ])(
    "refuses $kind without repairing or quoting rejected config values",
    async ({ config, nextAction }) => {
      writeConfig(config);
      const before = snapshotFiles();
      await updateAdmitCommand(contextPath);
      expect(readVerdict()).toMatchObject({
        verdict: "refuse",
        reasons: [
          {
            code: "invalid-config",
            message: expect.any(String),
            nextAction: expect.stringMatching(nextAction),
          },
        ],
      });
      expect(stdout).not.toContain("private-invalid-value");
      expect(process.exitCode).toBe(3);
      expect(snapshotFiles()).toEqual(before);
    },
  );

  it.each([
    { policy: "allowlist", verdict: "admit", exitCode: 0 },
    { policy: "invalid-policy", verdict: "refuse", exitCode: 3 },
  ])(
    "$verdict plugin-owned legacy Discord DM config ($policy) without writing",
    async ({ policy, verdict, exitCode }) => {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
      writeConfig({
        plugins: { allow: ["discord"] },
        channels: { discord: { dm: { policy, allowFrom: ["123456789"] } } },
      });
      const before = snapshotFiles();

      await updateAdmitCommand(contextPath);

      expect(readVerdict()).toMatchObject({
        verdict,
        ...(verdict === "admit"
          ? {
              reasons: [],
              warnings: expect.arrayContaining([
                { code: "config-warning", message: expect.stringContaining("legacy fields") },
              ]),
            }
          : { reasons: [expect.objectContaining({ code: "invalid-config" })] }),
      });
      expect(process.exitCode).toBe(exitCode);
      expect(snapshotFiles()).toEqual(before);
    },
  );

  it.each(["valid", "repairable"])(
    "refuses retired config that a selected older plugin considers %s",
    async (shape) => {
      const pluginDir = path.join(home, "older-whatsapp");
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "@openclaw/whatsapp",
          version: "2026.9.7",
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "whatsapp",
          channels: ["whatsapp"],
          configSchema: { type: "object", additionalProperties: false },
          channelConfigs: { whatsapp: { schema: { type: "object" } } },
          doctorContract: { configRepair: true },
        }),
      );
      fs.writeFileSync(
        path.join(pluginDir, "index.js"),
        "throw new Error('admission must not activate the plugin');\n",
      );
      fs.writeFileSync(
        path.join(pluginDir, "doctor-contract-api.cjs"),
        `const { stripRetiredChannelKeys } = require("openclaw/plugin-sdk/runtime-doctor-migrations");
module.exports = {
  legacyConfigRules: ${JSON.stringify(
    shape === "repairable"
      ? [{ path: ["channels", "whatsapp", "exposeErrorText"], message: "Retired ignored setting" }]
      : [],
  )},
  normalizeCompatibilityConfig: ({ cfg }) => {
    const changes = [];
    const result = stripRetiredChannelKeys({
      cfg, channelId: "whatsapp", keys: new Set(["exposeErrorText"]),
      scope: "root-and-accounts", onRemove: () => changes.push("Removed ignored setting"),
    });
    return { config: result.config, changes };
  },
};\n`,
      );
      writeConfig({
        plugins: { load: { paths: [pluginDir] }, allow: ["whatsapp"] },
        channels: {
          whatsapp: { exposeErrorText: false, accounts: { default: { exposeErrorText: true } } },
        },
      });
      fs.writeFileSync(`${configPath}.bak`, "retained backup bytes\n");
      const before = snapshotFiles();

      await runCli(["node", "openclaw", "update", "admit", "--context", contextPath]);

      expect(process.exitCode).toBe(3);
      expect(readVerdict()).toMatchObject({
        verdict: "refuse",
        reasons: [
          {
            code: "invalid-config",
            message: expect.stringContaining("channels.whatsapp.exposeErrorText"),
            nextAction: expect.stringContaining("Install OpenClaw 2026.9.5"),
          },
        ],
        facts: {
          checks: expect.arrayContaining([
            { name: "config", status: "refuse", detail: expect.any(String) },
          ]),
        },
      });
      expect(stdout).toContain("channels.whatsapp.accounts.default.exposeErrorText");
      expect(stderr).toBe("");
      expect(snapshotFiles()).toEqual(before);
      expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
    },
  );

  it("emits a parseable refusal when Doctor-projected database targets are incompatible", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
    writeConfig({
      plugins: { allow: ["discord"] },
      channels: { discord: { dm: { policy: "allowlist", allowFrom: ["123456789"] } } },
    });
    const checkSchemas = schemaPreflight.checkTargetDatabaseSchemasForContexts;
    vi.spyOn(schemaPreflight, "checkTargetDatabaseSchemasForContexts").mockImplementation(
      async (versions, contexts) => {
        if (contexts.some(({ config }) => config.channels?.discord?.dmPolicy === "allowlist")) {
          return {
            incompatible: [
              {
                kind: "agent",
                path: path.join(home, "projected-agent.sqlite"),
                foundVersion: 99999,
                supportedVersion: 1,
                writerAppVersion: "9999.1.1",
              },
            ],
            indeterminate: [],
          };
        }
        return checkSchemas(versions, contexts);
      },
    );
    const before = snapshotFiles();

    await updateAdmitCommand(contextPath);

    const verdict = readVerdict();
    expect(verdict).toMatchObject({
      verdict: "refuse",
      reasons: [expect.objectContaining({ code: "database-schema-preflight" })],
      warnings: [{ code: "config-warning", message: expect.stringContaining("legacy fields") }],
    });
    expect(verdict.facts.checks.filter(({ name }) => name === "database-schema")).toEqual([
      { name: "database-schema", status: "refuse", detail: expect.any(String) },
    ]);
    expect(verdict.facts.checks.filter(({ name }) => name === "config")).toEqual([
      { name: "config", status: "warn" },
    ]);
    expect(process.exitCode).toBe(3);
    expect(snapshotFiles()).toEqual(before);
  });

  it("validates plugin compatibility against the candidate despite inherited host identity", async () => {
    const pluginDir = path.join(home, "version-sensitive-plugin");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "candidate-version-fixture",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"], compat: { pluginApi: ">=2026.1.0" } },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "candidate-version-fixture",
        configSchema: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          additionalProperties: false,
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      "throw new Error('metadata inspection must not activate plugins');\n",
    );
    writeConfig({
      plugins: {
        load: { paths: [pluginDir] },
        allow: ["candidate-version-fixture"],
        entries: { "candidate-version-fixture": { enabled: true, config: { enabled: true } } },
      },
    });
    vi.stubEnv("OPENCLAW_VERSION", "1.0.0");
    const before = snapshotFiles();

    await updateAdmitCommand(contextPath);

    expect(readVerdict()).toMatchObject({ verdict: "admit", reasons: [] });
    expect(process.exitCode).toBe(0);
    expect(snapshotFiles()).toEqual(before);
    expect(process.env.OPENCLAW_VERSION).toBe("1.0.0");
  });

  it("refuses a newer database without changing its schema, history, or artifacts", async () => {
    const databasePath = resolveOpenClawStateSqlitePath();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(
      fs.readFileSync(new URL("./fixtures/admission-state-fac4.sql", import.meta.url), "utf8"),
    );
    database.exec("PRAGMA user_version=99999");
    database
      .prepare("INSERT INTO schema_meta VALUES ('primary','global',99999,NULL,'9999.1.1',1,1)")
      .run();
    database.close();
    const before = snapshotFiles();
    await updateAdmitCommand(contextPath);
    expect(readVerdict()).toMatchObject({
      verdict: "refuse",
      reasons: [expect.objectContaining({ code: "database-schema-preflight" })],
    });
    expect(process.exitCode).toBe(3);
    expect(snapshotFiles()).toEqual(before);
  });

  it("admits an incompatible selected runtime with an informational warning", async () => {
    vi.spyOn(runtimeGuard, "nodeVersionSatisfiesEngine").mockReturnValue(false);
    const nodeEngines = JSON.parse(
      fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ).engines.node;
    const before = snapshotFiles();
    await updateAdmitCommand(contextPath);
    expect(readVerdict()).toMatchObject({
      verdict: "admit",
      reasons: [],
      facts: {
        nodeEngines,
        checks: expect.arrayContaining([
          {
            name: "node-runtime",
            status: "warn",
            detail: expect.stringContaining(
              `requires Node ${nodeEngines}; selected runtime is Node ${process.versions.node}`,
            ),
          },
        ]),
      },
    });
    expect(process.exitCode).toBe(0);
    expect(snapshotFiles()).toEqual(before);
  });

  it("keeps unavailable plugin replacements advisory", async () => {
    vi.spyOn(pluginPreflight, "preflightConfiguredNpmPluginTargets").mockResolvedValueOnce([
      {
        pluginId: "fixture",
        reason: "registry unavailable",
        message: "Plugin replacement is unavailable; core update can continue.",
        guidance: [],
      },
    ]);
    await updateAdmitCommand(contextPath);
    expect(readVerdict()).toMatchObject({
      verdict: "admit",
      warnings: [{ code: "plugin-availability", message: expect.any(String) }],
      facts: { checks: expect.arrayContaining([{ name: "plugin-availability", status: "warn" }]) },
    });
    expect(process.exitCode).toBe(0);
  });

  it.each([undefined, "relative/context.json"])(
    "requires an absolute private context path (%s) without writing live state",
    async (value) => {
      const before = snapshotFiles();
      await updateAdmitCommand(value);
      expect(process.exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("context path is missing or invalid");
      expect(snapshotFiles()).toEqual(before);
    },
  );

  it.each([
    ["--context"],
    ["--context", "relative/context.json"],
    ["--context", "/fixture/context.json", "--context", "/fixture/other.json"],
  ])("rejects malformed admission argv without generic CLI startup (%j)", async (...args) => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    const before = snapshotFiles();
    await runCli(["node", "openclaw", "update", "admit", ...args]);
    expect(process.exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Candidate admission requires");
    expect(snapshotFiles()).toEqual(before);
  });

  it.each(
    [
      "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
      "OPENCLAW_GATEWAY_SERVICE_PID",
      "OPENCLAW_COMPATIBILITY_HOST_VERSION",
      "openclaw_update_run_id",
    ]
      .map((key) => ({ key, value: "untrusted-inherited-authority" }))
      .concat([{ key: "OPENCLAW_UPDATE_RUN_ID", value: "" }]),
  )(
    "rejects inherited $key ($value) before reading context or generic CLI startup",
    async ({ key, value }) => {
      vi.stubEnv(key, value);
      fs.unlinkSync(contextPath);
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
      const before = snapshotFiles();
      await runCli(["node", "openclaw", "update", "admit", "--context", contextPath]);
      expect(process.exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("authority-free");
      expect(snapshotFiles()).toEqual(before);
    },
  );

  it.each(["{", "{}"])("returns no verdict for invalid context %s", async (raw) => {
    fs.writeFileSync(contextPath, raw);
    await updateAdmitCommand(contextPath);
    expect(process.exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });
});
