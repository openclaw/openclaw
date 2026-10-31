import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { expectBytesEqual } from "../../test/helpers/file-snapshots.js";
import { resolveCliStartupPolicy } from "../cli/command-startup-policy.js";
import { bootstrapGatewayRun } from "../cli/gateway-cli/run-command.js";
import { resolveGatewayStartupFailureExitCode } from "../cli/gateway-cli/startup-maintenance.js";
import { testApi as configGuardTestApi } from "../cli/program/config-guard.js";
import * as serviceInstallation from "../cli/run-main-service-installation.js";
import { createGatewayDispatchStartupTrace } from "../cli/startup-trace.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import * as schemaMigrations from "./doctor-schema-migrations.js";

vi.mock("../cli/run-main-service-installation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof serviceInstallation>()),
  readOwnGatewayServiceCommand: vi.fn(),
}));
const test = it.runIf(process.platform === "linux");

afterEach(async () => {
  await cleanupSessionStateForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function fixture(run: (pathname: string, home: string) => Promise<void>) {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    await writeOpenClawConfig(home, {
      gateway: { mode: "local" },
      plugins: { enabled: false },
      meta: { migrations: { webhookListeners: true } },
      agents: { defaults: { workspace: path.join(home, "workspace") } },
    });
    openOpenClawStateDatabase();
    await cleanupSessionStateForTest();
    const pathname = path.join(stateDir, "agents", "openclaw", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(pathname), { recursive: true });
    {
      using db = new DatabaseSync(pathname);
      db.exec(
        await fs.readFile(
          new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v24.sql", import.meta.url),
          "utf8",
        ),
      );
      db.exec(`PRAGMA user_version=24;
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
        VALUES ('primary', 'agent', 24, 'openclaw', 1, 1);
        INSERT INTO cache_entries (scope, key, value_json, updated_at)
        VALUES ('activation', 'canary', '"retained"', 1);`);
    }
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "openclaw");
    vi.stubEnv("OPENCLAW_SERVICE_KIND", "gateway");
    vi.mocked(serviceInstallation.readOwnGatewayServiceCommand).mockResolvedValue({
      programArguments: ["node", "openclaw", "gateway"],
    });
    await run(pathname, home);
  });
}

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit(code: number): never {
    throw new Error(`unexpected exit ${code}`);
  },
};

async function bootstrap() {
  configGuardTestApi.resetConfigGuardStateForTests();
  const argv = ["node", "openclaw", "gateway", "run"];
  await withAgentDatabaseStartupAdmission(
    () =>
      bootstrapGatewayRun({
        opts: {},
        runtime,
        commandPath: ["gateway", "run"],
        startupPolicy: resolveCliStartupPolicy({
          argv,
          commandPath: ["gateway", "run"],
          jsonOutputMode: false,
        }),
        startupTrace: createGatewayDispatchStartupTrace(argv, "cli.main"),
      }),
    { deferInspections: false },
  );
}

test("backs up and migrates a managed activation, preserving data and skipping repair on healthy restart", async () => {
  await fixture(async (pathname) => {
    const migrate = schemaMigrations.prepareDoctorDatabaseMigrations;
    vi.spyOn(schemaMigrations, "prepareDoctorDatabaseMigrations").mockImplementationOnce(
      async (params) => {
        const result = await migrate(params);
        return {
          ...result,
          warnings: [...result.warnings, "synthetic completion receipt warning"],
        };
      },
    );
    await bootstrap();
    expect(runtime.error).toHaveBeenCalledWith("synthetic completion receipt warning");
    {
      using db = new DatabaseSync(pathname, { readOnly: true });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        db.prepare("SELECT value_json FROM cache_entries WHERE scope='activation'").get(),
      ).toEqual({ value_json: '"retained"' });
    }
    const before = await fs.readdir(path.dirname(pathname));
    const backup = before.find((file) => file.endsWith(".bak"));
    expect(backup).toBeDefined();
    {
      using db = new DatabaseSync(path.join(path.dirname(pathname), backup!), { readOnly: true });
      expect(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'").get(),
      ).toEqual({ schema_version: 24 });
    }
    const repairs = runtime.log.mock.calls.filter(([line]) =>
      String(line).startsWith("Systemd activation:"),
    );
    expect(repairs).toHaveLength(1);
    await cleanupSessionStateForTest();
    await bootstrap();
    expect(await fs.readdir(path.dirname(pathname))).toEqual(before);
    expect(
      runtime.log.mock.calls.filter(([line]) => String(line).startsWith("Systemd activation:")),
    ).toHaveLength(1);
  });
});

it.each(["ordinary", "child", "newer", "corrupt", "foreign"])(
  "preserves %s state without activation repair",
  async (kind) => {
    await fixture(async (pathname) => {
      if (kind === "ordinary") {
        vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
      } else if (kind === "child") {
        vi.mocked(serviceInstallation.readOwnGatewayServiceCommand).mockResolvedValue(undefined);
      } else if (kind === "corrupt") {
        await fs.writeFile(pathname, "synthetic corrupt database");
      } else {
        using db = new DatabaseSync(pathname);
        db.exec(
          kind === "newer"
            ? `PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`
            : "UPDATE schema_meta SET agent_id='foreign'",
        );
      }
      const before = await fs.readFile(pathname);
      await expect(bootstrap()).rejects.toThrow();
      expectBytesEqual(await fs.readFile(pathname), before, pathname);
      expect((await fs.readdir(path.dirname(pathname))).some((file) => file.includes(".bak"))).toBe(
        false,
      );
    });
  },
);

test("parks failed activation repair without migrating unbacked state", async () => {
  await fixture(async (pathname) => {
    const before = await fs.readFile(pathname);
    vi.spyOn(schemaMigrations, "prepareDoctorDatabaseMigrations").mockRejectedValueOnce(
      new Error("synthetic pre-migration backup refusal"),
    );
    const failure = await bootstrap().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("synthetic pre-migration backup refusal");
    expect(resolveGatewayStartupFailureExitCode(failure)).toBe(78);
    expectBytesEqual(await fs.readFile(pathname), before, pathname);
    expect((await fs.readdir(path.dirname(pathname))).some((file) => file.includes(".bak"))).toBe(
      false,
    );
  });
});
