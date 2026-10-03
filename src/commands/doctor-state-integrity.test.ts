import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { readDeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  detectStateIntegrityHealthIssues,
  noteStateIntegrity as noteStateIntegrityRaw,
  stateIntegrityIssueToHealthFinding,
  stateIntegrityIssueToRepairEffect,
} from "./doctor-state-integrity.js";
import {
  doctorChangesText,
  hasRepairPromptMessage,
  noteMock,
  noteStateIntegrity,
  repairPromptCalls,
  runStateIntegrityText,
  stateIntegrityText,
  withMainAgentRoster,
  writeSessionStore,
} from "./doctor-state-integrity.test-support.js";

vi.mock("../channels/plugins/bundled-ids.js", () => ({
  listBundledChannelIds: () => ["matrix", "whatsapp"],
  listBundledChannelPluginIds: () => ["matrix", "whatsapp"],
}));
vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix", "whatsapp"],
  hasBundledChannelPersistedAuthState: () => false,
}));

describe("doctor state integrity", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome = "";
  let stateDir = "";
  const wedged = {
    sessionId: "wedged-child",
    updatedAt: 0,
    abortedLastRun: true,
    subagentRecovery: {
      automaticAttempts: 2,
      lastAttemptAt: 10,
      lastRunId: "run-child",
      wedgedAt: 20,
      wedgedReason: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
    },
  };
  const decline = () => vi.fn(async (_params: { message: string }) => false);
  function createAgentDir(agentId: string, nested = true) {
    fs.mkdirSync(path.join(stateDir, "agents", agentId, ...(nested ? ["agent"] : [])), {
      recursive: true,
    });
  }

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_OAUTH_DIR",
      "OPENCLAW_AGENT_DIR",
    ]);
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-state-integrity-"));
    stateDir = path.join(tempHome, ".openclaw");
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_OAUTH_DIR");
    deleteTestEnvValue("OPENCLAW_AGENT_DIR");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    noteMock.mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupSessionStateForTest({ stateDir, rootPath: tempHome });
    envSnapshot.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("reports a missing state directory without skipping config permission findings", () => {
    fs.rmdirSync(stateDir);
    const configPath = path.join(tempHome, "openclaw.json");
    fs.writeFileSync(configPath, "{}\n", { mode: 0o644 });
    fs.chmodSync(configPath, 0o644);
    const issues = detectStateIntegrityHealthIssues({}, { configPath });
    const missing = issues.find((issue) => issue.kind === "missing-state-dir");
    if (!missing) {
      throw new Error("expected missing state directory issue");
    }
    expect(missing).toEqual({ kind: "missing-state-dir", path: stateDir });
    expect(stateIntegrityIssueToHealthFinding(missing)).toMatchObject({
      checkId: "core/doctor/state-integrity",
      severity: "error",
      path: stateDir,
      fixHint: "Run `openclaw doctor --fix` to create the state directory.",
    });
    expect(stateIntegrityIssueToRepairEffect(missing)).toEqual({
      kind: "state",
      action: "would-create-state-dir",
      target: stateDir,
      dryRunSafe: false,
    });
    if (process.platform !== "win32") {
      expect(issues.map(stateIntegrityIssueToHealthFinding)).toContainEqual(
        expect.objectContaining({
          severity: "warning",
          path: configPath,
          message: "Config file is group/world readable. Recommend chmod 600.",
        }),
      );
    }
    expect(issues.some((issue) => issue.kind === "missing-runtime-dir")).toBe(false);
  });

  it("reports permissive state and config file permissions", () => {
    if (process.platform === "win32") {
      return;
    }
    const configPath = path.join(tempHome, "openclaw.json");
    fs.chmodSync(stateDir, 0o755);
    fs.writeFileSync(configPath, "{}\n", { mode: 0o644 });
    fs.chmodSync(configPath, 0o644);
    expect(
      detectStateIntegrityHealthIssues({}, { configPath }).map(stateIntegrityIssueToHealthFinding),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          path: stateDir,
          message: "State directory permissions are too open. Recommend chmod 700.",
        }),
        expect.objectContaining({
          severity: "warning",
          path: configPath,
          message: "Config file is group/world readable. Recommend chmod 600.",
        }),
      ]),
    );
  });

  it("accepts lazy session directories in both structured and interactive diagnostics", async () => {
    const cfg = withMainAgentRoster({});
    expect(
      detectStateIntegrityHealthIssues(cfg).filter(
        (issue) =>
          "label" in issue &&
          (issue.label === "Sessions dir" || issue.label === "Session store dir"),
      ),
    ).toEqual([]);
    const confirmRuntimeRepair = decline();
    await noteStateIntegrityRaw(cfg, { confirmRuntimeRepair, note: noteMock });
    expect(stateIntegrityText()).not.toMatch(
      /CRITICAL: (?:Sessions dir|Session store dir) missing/,
    );
    expect(repairPromptCalls(confirmRuntimeRepair)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/^Create (?:Sessions dir|Session store dir) at/),
        }),
      ]),
    );
  });

  it("checks the source session store when process state is isolated", () => {
    const sourceHome = path.join(tempHome, "source-home");
    const sourceState = path.join(sourceHome, ".openclaw");
    const storeDir = path.join(sourceHome, "custom-store");
    fs.mkdirSync(sourceState, { recursive: true, mode: 0o700 });
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const accessSync = fs.accessSync;
    vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
      if (target === storeDir) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return accessSync(target, mode);
    });
    const readFileSync = fs.readFileSync;
    // Source isolation must not depend on whether the test host uses tmpfs.
    vi.spyOn(fs, "readFileSync").mockImplementation(
      (target, options?: fs.ReadFileSyncOptions | BufferEncoding | null) => {
        if (typeof options === "string") {
          return target === "/proc/self/mountinfo" && options === "utf8"
            ? "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw"
            : readFileSync(target, options);
        }
        if (options == null) {
          return readFileSync(target, options);
        }
        return readFileSync(target, options);
      },
    );
    expect(
      detectStateIntegrityHealthIssues(
        withMainAgentRoster({ session: { store: "~/custom-store/sessions.json" } }),
        {
          env: { HOME: sourceHome, OPENCLAW_STATE_DIR: sourceState },
        },
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "runtime-dir-not-writable",
        label: "Session store dir",
        path: storeDir,
      }),
    ]);
  });

  it("does not require OAuth storage for unpaired or unregistered channels", async () => {
    const confirmRuntimeRepair = decline();
    await noteStateIntegrity(
      { channels: { whatsapp: {}, icenter: { enabled: true, dmPolicy: "pairing" } } },
      { confirmRuntimeRepair, note: noteMock },
    );
    expect(hasRepairPromptMessage(confirmRuntimeRepair, "Create OAuth dir at")).toBe(false);
    expect(stateIntegrityText()).toContain("OAuth dir not present");
    expect(stateIntegrityText()).not.toContain("CRITICAL: OAuth dir missing");
  });

  it.each(["pairing", "explicit"])(
    "requires missing OAuth storage for %s configuration",
    async (mode) => {
      if (mode === "explicit") {
        setTestEnvValue("OPENCLAW_OAUTH_DIR", path.join(tempHome, ".oauth"));
      }
      const cfg: OpenClawConfig =
        mode === "pairing" ? { channels: { telegram: { dmPolicy: "pairing" } } } : {};
      const confirmRuntimeRepair = decline();
      await noteStateIntegrity(cfg, { confirmRuntimeRepair, note: noteMock });
      expect(hasRepairPromptMessage(confirmRuntimeRepair, "Create OAuth dir at")).toBe(true);
      expect(stateIntegrityText()).toContain("CRITICAL: OAuth dir missing");
    },
  );

  it.each(["list", "entries"] as const)(
    "distinguishes orphan directories from owned state with an agents.%s roster",
    async (roster) => {
      for (const id of ["main", "ops", "Research", "legacy", "openclaw", "crestodian"]) {
        createAgentDir(id);
      }
      createAgentDir("staging", false);
      const relocated = roster === "entries";
      if (relocated) {
        writeConfigMachineState("auth.sharedStore", { location: "state-db" });
        setTestEnvValue("OPENCLAW_AGENT_DIR", path.join(stateDir, "agents", "legacy", "agent"));
      }
      const researchReachable = fs.existsSync(path.join(stateDir, "agents", "research", "agent"));
      const cfg: OpenClawConfig = {
        agents: relocated
          ? { entries: { ops: { default: true }, research: {} } }
          : { list: [{ id: "main", default: true }, { id: "ops" }, { id: "research" }] },
      };
      const text = await runStateIntegrityText(cfg);
      const orphans = [
        "legacy",
        ...(relocated ? ["main"] : []),
        ...(!researchReachable ? ["Research (id research)"] : []),
      ];
      expect(text).toContain(`Examples: ${orphans.join(", ")}`);
      expect(text).toContain(
        `Found ${orphans.length} agent director${orphans.length === 1 ? "y" : "ies"} on disk`,
      );
      expect(text).toContain(`without a matching agents.${roster} entry`);
      expect(text).toContain(`Restore the missing agents.${roster} entries`);
      expect(text).toContain(
        "config-driven routing, identity, and model selection will ignore them",
      );
      expect(text).not.toContain(roster === "list" ? "agents.entries" : "agents.list");
    },
  );

  it("protects the shared legacy main auth-store for an ops-only roster", async () => {
    createAgentDir("main");
    expect(
      await runStateIntegrityText({ agents: { entries: { ops: { default: true } } } }),
    ).not.toContain("Examples: main");
  });

  it("orders equal-time SQLite recovery warnings by session key", async () => {
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
    const storePath = storeTemplate.replace("{agentId}", "main");
    for (const suffix of ["zeta", "alpha", "middle", "beta"]) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: `agent:main:subagent:${suffix}`, storePath },
        {
          ...wedged,
          sessionId: `session-${suffix}`,
          updatedAt: 30,
        },
      );
    }
    const confirmRuntimeRepair = decline();
    await noteStateIntegrity(
      { session: { store: storeTemplate } },
      { confirmRuntimeRepair, note: noteMock },
    );
    expect(stateIntegrityText()).toContain(
      "Examples: agent:main:subagent:alpha, agent:main:subagent:beta, agent:main:subagent:middle",
    );
    expect(
      repairPromptCalls(confirmRuntimeRepair).filter(({ message }) =>
        message?.startsWith("Clear stale aborted recovery flags"),
      ),
    ).toEqual([
      expect.objectContaining({
        message: "Clear stale aborted recovery flags for 4 wedged subagent sessions?",
      }),
    ]);
  });

  it("clears stale aborted recovery flags in the legacy store only when approved", async () => {
    const sessionKey = "agent:main:subagent:wedged-child";
    writeSessionStore({}, { [sessionKey]: wedged });
    await noteStateIntegrity(
      {},
      {
        confirmRuntimeRepair: async ({ message }) =>
          message.includes("Clear stale aborted recovery flags"),
        note: noteMock,
      },
    );
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const persisted: Record<string, { abortedLastRun?: boolean; updatedAt?: number }> = JSON.parse(
      fs.readFileSync(storePath, "utf8"),
    );
    expect(persisted[sessionKey]?.abortedLastRun).toBe(false);
    expect(persisted[sessionKey]?.updatedAt).toBeGreaterThan(0);
    expect(stateIntegrityText()).toContain("automatic restart recovery tombstoned");
    expect(stateIntegrityText()).toContain(sessionKey);
    expect(stateIntegrityText()).toContain("openclaw doctor --fix");
    expect(doctorChangesText()).toContain("Cleared aborted restart-recovery flags");
  });

  it.each([true, false])(
    "checks only the effective home's default state (exists=%s)",
    async (defaultExists) => {
      const osHome = path.join(tempHome, "os-home");
      const effectiveHome = path.join(tempHome, "relocated");
      fs.mkdirSync(path.join(osHome, ".openclaw"), { recursive: true, mode: 0o700 });
      if (defaultExists) {
        fs.mkdirSync(path.join(effectiveHome, ".openclaw"), { recursive: true, mode: 0o700 });
      }
      setTestEnvValue("HOME", osHome);
      setTestEnvValue("OPENCLAW_HOME", effectiveHome);
      const attemptedProbes: string[] = [];
      const outsideAccount = (target: fs.PathLike) => {
        const resolved = path.resolve(String(target));
        return (
          /^\/(?:Users|home)(?:\/|$)/u.test(resolved) &&
          resolved !== tempHome &&
          !resolved.startsWith(`${tempHome}${path.sep}`)
        );
      };
      const readdir = fs.readdirSync,
        exists = fs.existsSync,
        stat = fs.statSync;
      vi.spyOn(fs, "readdirSync").mockImplementation((target, options) => {
        if (outsideAccount(target)) {
          attemptedProbes.push(`readdir ${String(target)}`);
          throw new Error("account-root enumeration is outside Doctor's state scope");
        }
        return readdir(target, options);
      });
      vi.spyOn(fs, "existsSync").mockImplementation((target) => {
        if (outsideAccount(target)) {
          attemptedProbes.push(`exists ${String(target)}`);
          return false;
        }
        return exists(target);
      });
      vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
        if (outsideAccount(target)) {
          attemptedProbes.push(`stat ${String(target)}`);
          throw new Error("sibling-account metadata is outside Doctor's state scope");
        }
        return stat(target, options);
      });
      const text = await runStateIntegrityText({});
      expect(attemptedProbes).toEqual([]);
      expect(text.includes("Multiple state directories detected")).toBe(defaultExists);
      if (defaultExists) {
        expect(text).toContain("  - $OPENCLAW_HOME/.openclaw");
        expect(text).toContain(`Active state dir: ${stateDir}`);
      }
      expect(text).toContain("OAuth dir not present");
    },
  );
});

describe("doctor retained session integrity", () => {
  it("repairs canonical recovery state without editing retained rows deleted from SQLite", async () => {
    await withOpenClawTestState({ label: "retained-session-integrity" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
      const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
      for (const sessionKey of ["agent:main:kept", "agent:main:deleted"]) {
        Object.assign(store[sessionKey], {
          abortedLastRun: true,
          subagentRecovery: {
            automaticAttempts: 2,
            lastAttemptAt: 10,
            lastRunId: `run-${sessionKey}`,
            wedgedAt: 20,
            wedgedReason: "recovery requires reconciliation",
          },
        });
      }
      fs.writeFileSync(storePath, JSON.stringify(store));
      expect(
        (await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" }))
          .totals.importedEntries,
      ).toBe(2);
      const source = fs.readFileSync(storePath);
      const receiptParams = {
        cfg,
        env: state.env,
        target: { agentId: "main", storePath },
        sqlitePath: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
      };
      const receipt = readDeferredPluginSessionImport(receiptParams);
      expect(receipt).toBeDefined();
      await deleteSessionEntryLifecycle({
        ...scope,
        target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      });
      await recordDeferredPluginMigrations({
        env: state.env,
        pending: [],
        resolvedPluginIds: ["fixture-plugin"],
      });

      await noteStateIntegrityRaw(cfg, {
        confirmRuntimeRepair: async ({ message }) =>
          message.startsWith("Clear stale aborted recovery flags"),
        note: vi.fn(),
      });

      expect(loadSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.abortedLastRun).toBe(
        false,
      );
      expect(loadSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
      expect(fs.readFileSync(storePath)).toEqual(source);
      expect(readDeferredPluginSessionImport(receiptParams)).toEqual(receipt);
    });
  });
});
