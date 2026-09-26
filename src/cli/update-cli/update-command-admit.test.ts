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
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { runCli } from "../run-main.js";
import { registerUpdateCli } from "../update-cli.js";
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

  it("admits a missing custom plugin path with the candidate warning and preserves its bytes", async () => {
    writeConfig({ plugins: { load: { paths: [path.join(home, "missing-custom-plugin")] } } });
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
  });

  it("returns invalid-config with exit 3 without repairing or quoting rejected config values", async () => {
    writeConfig({ gateway: { port: "private-invalid-value" } });
    const before = snapshotFiles();
    await updateAdmitCommand(contextPath);
    expect(readVerdict()).toMatchObject({
      verdict: "refuse",
      reasons: [
        { code: "invalid-config", message: expect.any(String), nextAction: expect.any(String) },
      ],
    });
    expect(stdout).not.toContain("private-invalid-value");
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

  it.each([undefined, "", "relative/context.json"])(
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
    [],
    ["--context"],
    ["--context", "relative/context.json"],
    ["--context", "/fixture/context.json", "extra"],
    ["--context", "/fixture/context.json", "--context", "/fixture/other.json"],
    ["--context", "/fixture/context.json", "--json"],
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
      "OPENCLAW_UPDATE_RUN_ID",
      "OPENCLAW_UPDATE_IN_PROGRESS",
      "OPENCLAW_UPDATE_RUN_HANDOFF",
      "OPENCLAW_UPDATE_POST_CORE",
      "OPENCLAW_UPDATE_EXECUTOR_GRANT",
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

  it.each(["{", '{"protocol":2}', "{}"])(
    "returns no verdict for invalid context %s",
    async (raw) => {
      fs.writeFileSync(contextPath, raw);
      await updateAdmitCommand(contextPath);
      expect(process.exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).not.toBe("");
    },
  );
});
