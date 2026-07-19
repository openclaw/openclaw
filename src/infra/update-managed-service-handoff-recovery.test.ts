import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readRestartSentinel, writeRestartSentinel } from "./restart-sentinel.js";
import { managedServiceUpdateHandoffScriptForTest } from "./update-managed-service-handoff.js";
import {
  readUpdateRecoveryJournal,
  rewriteUpdateRecoveryJournal,
  UPDATE_RECOVERY_JOURNAL_ENV,
  UPDATE_RECOVERY_LOCATOR_ENV,
  writeUpdateRecoveryJournal,
} from "./update-recovery-journal.js";
import { createUpdateStateSnapshot } from "./update-state-snapshot.js";
import {
  claimUpdateTransactionRollback,
  writeUpdateTransactionMarker,
} from "./update-transaction-marker.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed update handoff recovery", () => {
  it("leaves the gateway stopped when rollback state is unreadable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-unreadable-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "systemctl-calls.log");
    await Promise.all([fs.mkdir(stateDir, { recursive: true }), fs.mkdir(binDir)]);
    await fs.writeFile(path.join(stateDir, "openclaw.sqlite"), "not a sqlite database");
    await fs.writeFile(
      path.join(binDir, "systemctl"),
      `#!/bin/sh\necho "$@" >> '${callsPath}'\nexit 0\n`,
      { mode: 0o755 },
    );

    const scriptPath = path.join(root, "handoff.cjs");
    const paramsPath = path.join(root, "params.json");
    await fs.writeFile(scriptPath, `${managedServiceUpdateHandoffScriptForTest}\n`, {
      mode: 0o700,
    });
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        parentPid: 0,
        parentExitTimeoutMs: 1,
        cwd: root,
        commandArgv: [process.execPath, "-e", "process.exit(7)"],
        commandLabel: "test update",
        handoffId: "handoff-unreadable",
        logPath: path.join(root, "handoff.log"),
        stateDatabasePath: path.join(stateDir, "openclaw.sqlite"),
        sensitivePaths: [],
        serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
      }),
    );

    await expect(
      execFileAsync(process.execPath, [scriptPath, paramsPath], {
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ code: 7 });

    await expect(fs.access(callsPath)).rejects.toThrow();
    await expect(fs.readFile(path.join(root, "handoff.log"), "utf8")).resolves.toContain(
      "gateway service recovery left stopped because rollback state was unreadable",
    );
  });

  it("restores package and state from the external journal when SQLite is unreadable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-journal-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const installOwner = path.join(stateDir, "tools", "node", "lib");
    const snapshotRoot = path.join(installOwner, ".openclaw-previous-state");
    const packageRoot = path.join(installOwner, "node_modules", "openclaw");
    const retainedPackageRoot = path.join(installOwner, ".openclaw-previous");
    const journalPath = path.join(snapshotRoot, "update-recovery-journal.json");
    const locatorPath = path.join(root, "recovery-locator.json");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "systemctl-calls.log");
    const externalConfig = path.join(root, "config", "openclaw.json");
    const requestedConfig = path.join(root, "config", "configured.json");
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(path.join(snapshotRoot, "state"), { recursive: true }),
      fs.mkdir(path.join(snapshotRoot, "config"), { recursive: true }),
      fs.mkdir(packageRoot, { recursive: true }),
      fs.mkdir(retainedPackageRoot, { recursive: true }),
      fs.mkdir(binDir),
    ]);
    await Promise.all([
      fs.writeFile(path.join(stateDir, "openclaw.sqlite"), "not a sqlite database"),
      fs.writeFile(path.join(stateDir, "value"), "new"),
      fs.writeFile(path.join(snapshotRoot, "state", "value"), "old"),
      fs.writeFile(path.join(snapshotRoot, "config", "openclaw.json"), '{"old":true}\n'),
      fs.writeFile(path.join(packageRoot, "version"), "new"),
      fs.writeFile(path.join(retainedPackageRoot, "version"), "old"),
      fs.writeFile(
        path.join(snapshotRoot, "update-state-snapshot.json"),
        JSON.stringify({
          version: 1,
          stateDir,
          requestedConfigPath: requestedConfig,
          configPath: externalConfig,
          configSymlinkTarget: "openclaw.json",
          strategy: "apfs-clone",
          databases: [],
          excludedStatePaths: ["tools/node/lib"],
          configDisposition: "external-present",
          configSnapshot: "config/openclaw.json",
        }),
      ),
      fs.writeFile(
        path.join(binDir, "systemctl"),
        `#!/bin/sh\necho "$@" >> '${callsPath}'\n[ "$2" = "is-active" ] && exit 3\nexit 0\n`,
        { mode: 0o755 },
      ),
    ]);
    await fs.symlink("version", path.join(retainedPackageRoot, "current"));
    await fs.symlink("value", path.join(snapshotRoot, "state", "current-value"));
    await fs.mkdir(externalConfig, { recursive: true });
    await fs.writeFile(requestedConfig, "candidate config path\n");
    await writeUpdateRecoveryJournal({
      filePath: journalPath,
      handoffId: "handoff-journal",
      payload: {
        kind: "update",
        status: "skipped",
        ts: Date.now(),
        stats: {
          handoffId: "handoff-journal",
          updatePhase: "restart",
          confirmationTier: "delivery",
          confirmationStatus: "pending",
          packageRoot,
          retainedPackageRoot,
          stateSnapshotRoot: snapshotRoot,
        },
      },
    });
    await fs.writeFile(
      locatorPath,
      JSON.stringify({ version: 1, handoffId: "handoff-journal", journalPath }),
    );

    const scriptPath = path.join(root, "handoff.cjs");
    const paramsPath = path.join(root, "params.json");
    await fs.writeFile(scriptPath, `${managedServiceUpdateHandoffScriptForTest}\n`, {
      mode: 0o700,
    });
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        parentPid: 0,
        parentExitTimeoutMs: 1,
        cwd: root,
        commandArgv: [process.execPath, "-e", "process.exit(7)"],
        commandLabel: "test update",
        handoffId: "handoff-journal",
        logPath: path.join(root, "handoff.log"),
        stateDatabasePath: path.join(stateDir, "openclaw.sqlite"),
        recoveryLocatorPath: locatorPath,
        sensitivePaths: [],
        serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
      }),
    );

    await expect(
      execFileAsync(process.execPath, [scriptPath, paramsPath], {
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ code: 7 });

    expect(await fs.readFile(path.join(packageRoot, "version"), "utf8")).toBe("old");
    expect(await fs.readlink(path.join(packageRoot, "current"))).toBe("version");
    expect(await fs.readFile(path.join(stateDir, "value"), "utf8")).toBe("old");
    expect(await fs.readlink(path.join(stateDir, "current-value"))).toBe("value");
    expect(await fs.readFile(externalConfig, "utf8")).toBe('{"old":true}\n');
    expect(await fs.readlink(requestedConfig)).toBe("openclaw.json");
    await expect(fs.access(path.join(snapshotRoot, "state"))).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(snapshotRoot, "state", "value"), "utf8")).toBe("old");
    await expect(fs.access(journalPath)).resolves.toBeUndefined();
    expect(await fs.readFile(callsPath, "utf8")).toBe(
      [
        "--user stop openclaw-gateway.service",
        "--user is-active --quiet openclaw-gateway.service",
        "--user start openclaw-gateway.service",
        "",
      ].join("\n"),
    );
  });

  it("restores retention before restarting after update-child failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-package-recovery-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const packageRoot = path.join(root, "global", "openclaw");
    const retainedPackageRoot = path.join(root, "global", ".openclaw-previous");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "systemctl-calls.log");
    const journalPath = path.join(root, "recovery-journal.json");
    const locatorPath = path.join(root, "recovery-locator.json");
    const cleanupFaultPath = path.join(root, "cleanup-fault.cjs");
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(packageRoot, { recursive: true }),
      fs.mkdir(retainedPackageRoot, { recursive: true }),
      fs.mkdir(binDir, { recursive: true }),
    ]);
    await fs.writeFile(path.join(packageRoot, "version"), "new");
    await fs.writeFile(path.join(retainedPackageRoot, "version"), "old");
    await fs.writeFile(
      cleanupFaultPath,
      [
        'const fs = require("node:fs");',
        "const originalRmSync = fs.rmSync;",
        "fs.rmSync = (target, options) => {",
        '  if (String(target).includes(".handoff-rollback-") && String(target).endsWith(".displaced") && fs.existsSync(target)) {',
        '    throw new Error("candidate cleanup denied");',
        "  }",
        "  return originalRmSync(target, options);",
        "};",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(binDir, "systemctl"),
      `#!/bin/sh\necho "$@" >> '${callsPath}'\n[ "$2" = "is-active" ] && exit 3\n[ "$2" = "start" ] && exit 1\nexit 0\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(stateDir, "value"), "old");
    const snapshot = await createUpdateStateSnapshot({
      retainedPackageRoot,
      currentPackageRoot: packageRoot,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      timeoutMs: 1_000,
      runCommand: async (argv) => {
        await fs.cp(argv.at(-2)!, argv.at(-1)!, { recursive: true });
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      [UPDATE_RECOVERY_JOURNAL_ENV]: journalPath,
      [UPDATE_RECOVERY_LOCATOR_ENV]: locatorPath,
    };
    await writeUpdateTransactionMarker({
      result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
      meta: { handoffId: "handoff-1" },
      confirmationTier: "delivery",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: snapshot.root,
        nodePath: process.execPath,
      },
      env,
    });
    await fs.writeFile(path.join(stateDir, "value"), "new");
    await claimUpdateTransactionRollback({
      handoffId: "handoff-1",
      rollbackOwner: "dead-child",
      reason: "rollback started",
      env,
    });
    closeOpenClawStateDatabaseForTest();

    const scriptPath = path.join(root, "handoff.cjs");
    const paramsPath = path.join(root, "params.json");
    await fs.writeFile(scriptPath, `${managedServiceUpdateHandoffScriptForTest}\n`, {
      mode: 0o700,
    });
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        parentPid: 0,
        parentExitTimeoutMs: 1,
        cwd: root,
        commandArgv: [process.execPath, "-e", "process.exit(7)"],
        commandLabel: "test update",
        handoffId: "handoff-1",
        logPath: path.join(root, "handoff.log"),
        stateDatabasePath: resolveOpenClawStateSqlitePath(env),
        recoveryLocatorPath: locatorPath,
        sensitivePaths: [],
        serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
      }),
    );

    await expect(
      execFileAsync(process.execPath, ["--require", cleanupFaultPath, scriptPath, paramsPath], {
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ code: 7 });

    expect(await fs.readFile(path.join(packageRoot, "version"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(retainedPackageRoot, "version"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(stateDir, "value"), "utf8")).toBe("old");
    await expect(fs.readFile(path.join(root, "handoff.log"), "utf8")).resolves.toContain(
      "deferred displaced package cleanup",
    );
    expect(await fs.readFile(callsPath, "utf8")).toBe(
      [
        "--user stop openclaw-gateway.service",
        "--user is-active --quiet openclaw-gateway.service",
        "--user start openclaw-gateway.service",
        "",
      ].join("\n"),
    );
    const marker = await readUpdateRecoveryJournal(journalPath);
    expect(marker.payload).toMatchObject({
      status: "error",
      stats: {
        updatePhase: "failed",
        confirmationStatus: "failed",
        reason: "update-rollback-failed: retained gateway service activation failed",
      },
    });
    expect((await readRestartSentinel(env))?.payload.stats).toMatchObject({
      updatePhase: "failed",
      confirmationStatus: "failed",
      reason: "update-rollback-failed: retained gateway service activation failed",
    });
  });

  it("keeps the service stopped when terminal recovery journal persistence fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-journal-failure-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const packageRoot = path.join(root, "global", "openclaw");
    const retainedPackageRoot = path.join(root, "global", ".openclaw-previous");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "systemctl-calls.log");
    const journalPath = path.join(root, "recovery-journal.json");
    const locatorPath = path.join(root, "recovery-locator.json");
    const journalFaultPath = path.join(root, "journal-fault.cjs");
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(packageRoot, { recursive: true }),
      fs.mkdir(retainedPackageRoot, { recursive: true }),
      fs.mkdir(binDir, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(packageRoot, "version"), "new"),
      fs.writeFile(path.join(retainedPackageRoot, "version"), "old"),
      fs.writeFile(path.join(stateDir, "value"), "old"),
      fs.writeFile(
        path.join(binDir, "systemctl"),
        `#!/bin/sh\necho "$@" >> '${callsPath}'\n[ "$2" = "is-active" ] && exit 3\nexit 0\n`,
        { mode: 0o755 },
      ),
      fs.writeFile(
        journalFaultPath,
        [
          'const fs = require("node:fs");',
          "const originalRenameSync = fs.renameSync;",
          "fs.renameSync = (source, target) => {",
          "  if (target === process.env.OPENCLAW_TEST_JOURNAL_PATH) {",
          '    const journal = JSON.parse(fs.readFileSync(source, "utf8"));',
          '    if (journal.committedPayload?.stats?.updatePhase === "rolled-back") {',
          '      throw new Error("terminal journal rename denied");',
          "    }",
          "  }",
          "  return originalRenameSync(source, target);",
          "};",
          "",
        ].join("\n"),
      ),
    ]);
    const snapshot = await createUpdateStateSnapshot({
      retainedPackageRoot,
      currentPackageRoot: packageRoot,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      timeoutMs: 1_000,
      runCommand: async (argv) => {
        await fs.cp(argv.at(-2)!, argv.at(-1)!, { recursive: true });
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    const handoffId = "handoff-journal-failure";
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      [UPDATE_RECOVERY_JOURNAL_ENV]: journalPath,
      [UPDATE_RECOVERY_LOCATOR_ENV]: locatorPath,
    };
    await writeUpdateTransactionMarker({
      result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
      meta: { handoffId },
      confirmationTier: "delivery",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: snapshot.root,
        nodePath: process.execPath,
      },
      env,
    });
    await fs.writeFile(path.join(stateDir, "value"), "new");
    await claimUpdateTransactionRollback({
      handoffId,
      rollbackOwner: "dead-child",
      reason: "rollback started",
      env,
    });
    closeOpenClawStateDatabaseForTest();

    const scriptPath = path.join(root, "handoff.cjs");
    const paramsPath = path.join(root, "params.json");
    await fs.writeFile(scriptPath, `${managedServiceUpdateHandoffScriptForTest}\n`, {
      mode: 0o700,
    });
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        parentPid: 0,
        parentExitTimeoutMs: 1,
        cwd: root,
        commandArgv: [process.execPath, "-e", "process.exit(7)"],
        commandLabel: "test update",
        handoffId,
        logPath: path.join(root, "handoff.log"),
        stateDatabasePath: resolveOpenClawStateSqlitePath(env),
        recoveryLocatorPath: locatorPath,
        sensitivePaths: [],
        serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
      }),
    );

    await expect(
      execFileAsync(process.execPath, ["--require", journalFaultPath, scriptPath, paramsPath], {
        env: {
          ...process.env,
          OPENCLAW_TEST_JOURNAL_PATH: journalPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      }),
    ).rejects.toMatchObject({ code: 7 });

    expect(await fs.readFile(path.join(packageRoot, "version"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(stateDir, "value"), "utf8")).toBe("old");
    expect(await fs.readFile(callsPath, "utf8")).toBe(
      [
        "--user stop openclaw-gateway.service",
        "--user is-active --quiet openclaw-gateway.service",
        "",
      ].join("\n"),
    );
    expect((await readUpdateRecoveryJournal(journalPath)).payload.stats).toMatchObject({
      updatePhase: "rolling-back",
      confirmationStatus: "failed",
    });
    await expect(fs.readFile(path.join(root, "handoff.log"), "utf8")).resolves.toContain(
      "gateway service recovery left stopped because terminal journal persistence failed",
    );
  });

  it("preserves a confirmed package when the update child exits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-confirmed-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const packageRoot = path.join(root, "global", "openclaw");
    const retainedPackageRoot = path.join(root, "global", ".openclaw-previous");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "systemctl-calls.log");
    const snapshotRoot = path.join(root, "snapshot");
    const journalPath = path.join(snapshotRoot, "update-recovery-journal.json");
    const locatorPath = path.join(root, "recovery-locator.json");
    await Promise.all([
      fs.mkdir(packageRoot, { recursive: true }),
      fs.mkdir(retainedPackageRoot, { recursive: true }),
      fs.mkdir(binDir, { recursive: true }),
      fs.mkdir(snapshotRoot, { recursive: true }),
    ]);
    await fs.writeFile(path.join(packageRoot, "version"), "new");
    await fs.writeFile(path.join(retainedPackageRoot, "version"), "old");
    await fs.writeFile(
      path.join(binDir, "systemctl"),
      `#!/bin/sh\necho "$@" >> '${callsPath}'\nexit 0\n`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      [UPDATE_RECOVERY_JOURNAL_ENV]: journalPath,
      [UPDATE_RECOVERY_LOCATOR_ENV]: locatorPath,
    };
    await writeUpdateTransactionMarker({
      result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
      meta: { handoffId: "handoff-confirmed" },
      confirmationTier: "delivery",
      rollback: {
        packageRoot,
        retainedPackageRoot,
        stateSnapshotRoot: snapshotRoot,
        nodePath: process.execPath,
      },
      env,
    });
    const { advanceUpdateTransactionMarker, markUpdateTransactionProbationReleased } =
      await import("./update-transaction-marker.js");
    await advanceUpdateTransactionMarker({
      handoffId: "handoff-confirmed",
      phase: "healthy",
      env,
    });
    const pending = (await readRestartSentinel(env))!.payload;
    const stagedConfirmed = {
      ...pending,
      stats: {
        ...pending.stats,
        updatePhase: "confirm" as const,
        confirmationStatus: "delivery-acked" as const,
        reason: "journal-staged",
      },
    };
    await rewriteUpdateRecoveryJournal({
      filePath: journalPath,
      handoffId: "handoff-confirmed",
      stageConfirmation: true,
      rewrite: () => stagedConfirmed,
    });
    const confirmed = {
      ...stagedConfirmed,
      stats: { ...stagedConfirmed.stats, reason: "sqlite-confirmed" },
    };
    await writeRestartSentinel(confirmed, env);
    await markUpdateTransactionProbationReleased({ handoffId: "handoff-confirmed", env });
    closeOpenClawStateDatabaseForTest();

    const scriptPath = path.join(root, "handoff.cjs");
    const paramsPath = path.join(root, "params.json");
    await fs.writeFile(scriptPath, `${managedServiceUpdateHandoffScriptForTest}\n`, {
      mode: 0o700,
    });
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        parentPid: 0,
        parentExitTimeoutMs: 1,
        cwd: root,
        commandArgv: [process.execPath, "-e", "process.exit(7)"],
        commandLabel: "test update",
        handoffId: "handoff-confirmed",
        logPath: path.join(root, "handoff.log"),
        stateDatabasePath: resolveOpenClawStateSqlitePath(env),
        recoveryLocatorPath: locatorPath,
        sensitivePaths: [],
        serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
      }),
    );

    await expect(
      execFileAsync(process.execPath, [scriptPath, paramsPath], {
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ code: 7 });

    expect(await fs.readFile(path.join(packageRoot, "version"), "utf8")).toBe("new");
    expect(await fs.readFile(callsPath, "utf8")).toBe("--user start openclaw-gateway.service\n");
    await expect(fs.access(snapshotRoot)).rejects.toThrow();
    expect(await readRestartSentinel(env)).toBeNull();
  });
});
