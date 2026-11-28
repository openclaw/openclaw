import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as storeFiles from "../test-utils/store-snapshot.test-support.js";
import {
  traceConfigFlowPendingInputs,
  type DoctorConfigFlowPendingParams,
} from "./doctor-config-flow-pending.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import type {
  DoctorMaintenancePending,
  DoctorMaintenancePendingCheck,
} from "./doctor-maintenance-pending.js";

const handles: DatabaseSync[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

type Install = { home: string; stateDir: string; configPath: string; workspace: string };

async function makeInstall(home: string, config: (install: Install) => Record<string, unknown>) {
  const stateDir = path.join(home, ".openclaw");
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const install = { home, stateDir, configPath: path.join(stateDir, "openclaw.json"), workspace };
  await fs.writeFile(install.configPath, JSON.stringify(config(install), null, 2));
  return install;
}

/** Runs Doctor's config flow under --fix and commits its config write; returns whether it wrote. */
async function runConfigFlow(install: Install): Promise<boolean> {
  await using ctx = await prepareDoctorContext(install.configPath);
  const wrote = ctx.configResult.shouldWriteConfig === true;
  if (wrote) {
    expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  return wrote;
}

/** Runs the flow until it writes nothing, as repeated `doctor --fix` runs settle an install. */
async function settle(install: Install) {
  for (let run = 0; run < 3; run += 1) {
    if (!(await runConfigFlow(install))) {
      return;
    }
  }
  throw new Error("Doctor's config flow kept writing the config");
}

/** Holds the state database open as a serving Gateway does, so its WAL sidecars exist. */
function holdStateDatabase() {
  const gateway = new DatabaseSync(resolveOpenClawStateSqlitePath(process.env));
  gateway.prepare("SELECT count(*) FROM sqlite_schema").get();
  handles.push(gateway);
}

function releaseStateDatabase() {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
}

const decidedOnly = (decisions: Map<string, DoctorMaintenancePending>) =>
  new Map([...decisions].filter(([id]) => !UNDECIDED.includes(id)));

async function traceRepairs(params: Partial<DoctorConfigFlowPendingParams> = {}) {
  const traced = new Map<string, DoctorMaintenancePending>();
  const trace = async (step: string, check?: DoctorMaintenancePendingCheck) => {
    const pending = check ? await check() : "work";
    traced.set(step, pending);
    return pending !== "none";
  };
  await traceConfigFlowPendingInputs(trace, {
    env: process.env,
    integrityCheck: "quick",
    ...params,
  });
  return new Map(
    [...traced]
      .filter(([step]) => step.startsWith("config-flow.config-repairs."))
      .map(([step, pending]) => [step.slice("config-flow.config-repairs.".length), pending]),
  );
}

// Every config repair stage the flow runs after its preflight, in flow order.
const STAGES = [
  "legacy-compatibility",
  "agent-roster",
  "session-store-owner",
  "model-metadata",
  "compatibility-values",
  "command-owner-targets",
  "channel-account-bindings",
  "retired-phone-control",
  "installed-plugin-ids",
  "plugin-auto-enable",
  "channel-config-sequences",
  "channel-stale-config",
  "hooks-token-reuse",
  "system-agent-workspace",
  "channel-repairs",
  "bundled-plugin-load-paths",
  "stale-managed-npm-plugins",
  "plugin-host-links",
  "legacy-auth-profile-stores",
  "codex-routes",
  "context-engine-plugin-id",
  "context-engine-host-compat",
  "missing-plugin-installs",
  "stale-plugin-config",
  "invalid-plugin-config",
  "allowlist-policy-allow-from",
  "open-policy-allow-from",
  "group-allow-from-fallback",
  "stale-subagent-allowlists",
  "exec-safe-bins",
  "tailscale-profile-identities",
  "gateway-owner-profile",
  "plugin-runtime-symlinks",
  "oauth-profile-shadows",
  "auth-profile-migration",
  "stale-auth-orders",
  "model-replacements",
  "implicit-openai-primary",
  "stale-agent-model-refs",
  "model-retirement-deferral",
  "heartbeat-retirement",
  "unknown-config-keys",
];

// The stages that write stores or files, or whose plugin hooks cannot say whether they have
// work, in flow order. Each keeps answering work until its owner has a read-only predicate.
const UNDECIDED = [
  "session-store-owner",
  "retired-phone-control",
  "stale-managed-npm-plugins",
  "plugin-host-links",
  "legacy-auth-profile-stores",
  "context-engine-host-compat",
  "missing-plugin-installs",
  "tailscale-profile-identities",
  "gateway-owner-profile",
  "plugin-runtime-symlinks",
  "oauth-profile-shadows",
  "auth-profile-migration",
  "stale-auth-orders",
  "implicit-openai-primary",
  "heartbeat-retirement",
];

const healthy = (install: Install) => ({
  gateway: { mode: "local", auth: { mode: "token", token: "t".repeat(32) } },
  agents: { list: [{ id: "main", default: true, workspace: install.workspace }] },
});

type Config = Record<string, any>;

/** A settled install whose config is then replaced by `seed(settled)`, as an operator edit would. */
async function seededInstall(home: string, seed: (config: Config) => Config) {
  const install = await makeInstall(home, healthy);
  await settle(install);
  const settled = JSON.parse(await fs.readFile(install.configPath, "utf8")) as Config;
  await fs.writeFile(install.configPath, JSON.stringify(seed(settled), null, 2));
  return install;
}

describe("doctor config-flow config repairs pending", () => {
  it("traces every stage in flow order, none for each decided one once the flow writes nothing", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const install = await makeInstall(home, healthy);
      await settle(install);
      holdStateDatabase();
      const before = storeFiles.snapshotStoreFiles(home);

      const decisions = await traceRepairs();

      // Beside the held store, a check creates or changes no file.
      expect(storeFiles.changedStoreFiles(before, storeFiles.snapshotStoreFiles(home))).toEqual([]);
      expect([...decisions.keys()]).toEqual(STAGES);
      // Only the stages without a check keep the step at work.
      expect([...decisions].filter(([, pending]) => pending !== "none")).toEqual(
        UNDECIDED.map((id) => [id, "work"]),
      );
      // Requested model replacements are the replacement stage's work.
      const replacing = await traceRepairs({
        modelReplacements: [
          {
            from: "openai/gpt-daybreak-blue-latest",
            to: "openai/gpt-5.5",
            accessProgram: "standard",
          },
        ],
      });
      expect(replacing.get("model-replacements")).toBe("work");
      releaseStateDatabase();
      // The same install: the real flow writes nothing.
      expect(await runConfigFlow(install)).toBe(false);
    });
  }, 240_000);

  it("answers undecidable without creating sidecars when no connection holds the state database", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const install = await makeInstall(home, healthy);
      await settle(install);
      storeFiles.removeEmptySqliteSidecars(install.stateDir);
      expect(storeFiles.listSqliteSidecars(home)).toEqual([]);
      const before = storeFiles.snapshotStoreFiles(home);

      const decisions = await traceRepairs();

      expect(storeFiles.changedStoreFiles(before, storeFiles.snapshotStoreFiles(home))).toEqual([]);
      expect(new Set(decidedOnly(decisions).values())).toEqual(new Set(["undecidable"]));
    });
  }, 240_000);

  // Each seed gives a config-only stage work on a settled install.
  const WORK: Array<[string, (config: Config) => Config]> = [
    ["agent-roster", ({ agents: _agents, ...config }) => config],
    [
      "hooks-token-reuse",
      (config) => ({ ...config, hooks: { enabled: true, token: config.gateway.auth.token } }),
    ],
    [
      "stale-plugin-config",
      (config) => ({
        ...config,
        plugins: { allow: ["ghost-plugin"], entries: { "ghost-plugin": { enabled: true } } },
      }),
    ],
    [
      "plugin-auto-enable",
      (config) => ({ ...config, channels: { telegram: { botToken: "123:abc" } } }),
    ],
  ];

  it.each(WORK)(
    "%s: answers work, the flow repairs the config, then the stage answers none",
    async (stage, seed) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const install = await seededInstall(home, seed);
        holdStateDatabase();
        expect((await traceRepairs()).get(stage)).toBe("work");
        releaseStateDatabase();

        expect(await runConfigFlow(install)).toBe(true);

        holdStateDatabase();
        expect((await traceRepairs()).get(stage)).toBe("none");
        releaseStateDatabase();
        expect(await runConfigFlow(install)).toBe(false);
      });
    },
    240_000,
  );

  it("keeps channel hooks undecidable for a configured channel that implements them", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const install = await seededInstall(home, (config) => ({
        ...config,
        channels: { telegram: { botToken: "123:abc" } },
      }));
      await settle(install);
      holdStateDatabase();
      const decisions = await traceRepairs();
      // Telegram implements the config sequence and the repair hook, not stale-config cleanup.
      expect(decisions.get("channel-config-sequences")).toBe("undecidable");
      expect(decisions.get("channel-repairs")).toBe("undecidable");
      expect(decisions.get("channel-stale-config")).toBe("none");
    });
  }, 240_000);

  it("answers undecidable for a warning the repair keeps reporting without a change", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      // A safe binary without a profile: the repair warns and changes nothing.
      const install = await seededInstall(home, (config) => ({
        ...config,
        tools: { exec: { safeBins: ["jq"] } },
      }));
      holdStateDatabase();
      expect((await traceRepairs()).get("exec-safe-bins")).toBe("undecidable");
      releaseStateDatabase();
      expect(await runConfigFlow(install)).toBe(false);
    });
  }, 240_000);

  it("leaves every decided stage undecidable for a config the flow must migrate first", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const install = await seededInstall(home, (config) => ({
        ...config,
        routing: { transcribeAudio: { command: ["whisper"] } },
      }));
      holdStateDatabase();
      const decisions = await traceRepairs();
      expect(new Set(decidedOnly(decisions).values())).toEqual(new Set(["undecidable"]));
      releaseStateDatabase();
      expect(await runConfigFlow(install)).toBe(true);
    });
  }, 240_000);

  it("leaves stages that wait for plugin convergence undecidable during a package swap", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await makeInstall(home, healthy);
      const decisions = await traceRepairs({
        env: { ...process.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      });
      expect(decisions.get("stale-plugin-config")).toBe("undecidable");
      expect(decisions.get("stale-agent-model-refs")).toBe("undecidable");
      expect(decisions.get("model-retirement-deferral")).toBe("undecidable");
    });
  }, 240_000);
});
