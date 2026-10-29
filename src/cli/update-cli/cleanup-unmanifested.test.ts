import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  collectUpdateCleanupInventory,
  type RecoveryCleanupReport,
} from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "../../commands/doctor-session-sqlite-retirement.js";
import { selectUnmanifestedRecovery } from "../../commands/update-cleanup-unmanifested.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { resolveUpdateCaptureRoot } from "../../infra/update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../../infra/update-capture-privacy-marker.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { retainedCheckpointBinding } from "../../infra/update-retained-checkpoint.test-support.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { registerUpdateCli } from "../update-cli.js";
import { updateCleanupCommand } from "./cleanup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  // Resolve the actual handoff store, not just HOME/state. The runner supplies private TMPDIR.
  const handoff = fs.realpathSync(path.dirname(resolveManagedUpdateLeaseDatabasePath()));
  expect(handoff.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)).toBe(true);
  expect(handoff).not.toBe("/private/tmp/openclaw");
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  await cleanupSessionStateForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function fixture() {
  const home = dirs.make("cleanup-unmanifested-");
  const stateDir = path.join(home, ".openclaw");
  const state = path.join(stateDir, "state");
  fs.mkdirSync(state, { recursive: true });
  const original = path.join(state, "openclaw.sqlite.pre-startup-migration-old.bak");
  const other = path.join(state, "openclaw.sqlite.pre-doctor-other.bak");
  fs.writeFileSync(original, "retained original");
  fs.writeFileSync(other, "other retained original");
  const env = {
    HOME: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  return { home, stateDir, original, other, env };
}
type Fixture = ReturnType<typeof fixture>;

function orphan(f: Fixture) {
  const runId = randomUUID();
  const directory = path.join(resolveUpdateCaptureRoot(f.stateDir), runId);
  fs.mkdirSync(path.join(directory, "payload"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
    UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
  );
  fs.writeFileSync(path.join(directory, "payload", "original"), "capture payload");
  writeFixtureJsonSync(path.join(directory, "manifest.json"), {
    schemaVersion: 2,
    kind: "update-recovery",
    generation: { kind: "baseline" },
    databases: [],
    runId,
    installRoot: f.home,
    stateDir: f.stateDir,
    configPath: f.env.OPENCLAW_CONFIG_PATH,
    configPaths: [f.env.OPENCLAW_CONFIG_PATH],
    creator: { host: "fixture", pid: 1, startIdentity: "1" },
    drivers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    roots: [f.env.OPENCLAW_CONFIG_PATH],
    excludedRoots: [],
    protectedPaths: [f.env.OPENCLAW_CONFIG_PATH],
    entries: [
      {
        kind: "missing",
        sourcePath: f.env.OPENCLAW_CONFIG_PATH,
        sqlite: false,
        directory: false,
      },
    ],
  });
  return directory;
}

function preview(f: Fixture, paths: string[]) {
  const inventory = collectUpdateCleanupInventory({ cfg: {}, env: f.env });
  selectUnmanifestedRecovery({ inventory, paths, cfg: {}, env: f.env });
  return inventory.report;
}
function report(): RecoveryCleanupReport {
  return vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)![0] as RecoveryCleanupReport;
}
function pendingRecovery(f: Fixture, manifestPath: string) {
  const options = { env: f.env };
  const runId = createUpdateRun({ trigger: "cli" }, options).runId;
  const runtime = { root: f.home, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const record = createRetainedUpdateRecovery({ runId, from: runtime, to: runtime }, options);
  record.checkpoint = retainedCheckpointBinding(record);
  record.checkpoint.ref.manifestPath = manifestPath;
  storeRetainedUpdateRecovery(record, options);
  closeOpenClawStateDatabaseForTest();
  return runId;
}

it("keeps unmanifested originals and orphan captures protected by default, even with --yes", async () => {
  const f = fixture();
  const capture = orphan(f);
  await withEnvAsync(f.env, async () => {
    await updateCleanupCommand({ yes: true, json: true });
    expect(report().artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: f.original,
          outcome: "protected",
          reason: "unmanifested-recovery-original",
        }),
        expect.objectContaining({
          path: capture,
          outcome: "protected",
          reason: "orphan-update-capture",
        }),
      ]),
    );
    expect(fs.readFileSync(f.original, "utf8")).toBe("retained original");
    expect(fs.readFileSync(path.join(capture, "payload", "original"), "utf8")).toBe(
      "capture payload",
    );
  });
});

it("parses repeated exact paths, previews consequence and bytes, then removes only the selected originals", async () => {
  const f = fixture();
  const capture = orphan(f);
  await withEnvAsync(f.env, async () => {
    const argv = [
      "update",
      "cleanup",
      "--include-unmanifested",
      f.original,
      "--include-unmanifested",
      capture,
    ];
    await runRegisteredCli({ register: registerUpdateCli, argv: [...argv, "--dry-run", "--json"] });
    const selected = report().artifacts.filter((item) => item.outcome === "candidate");
    expect(selected.map((item) => item.path).toSorted()).toEqual([f.original, capture].toSorted());
    expect(selected.find((item) => item.path === f.original)).toMatchObject({
      bytes: 17,
      consequence: expect.stringContaining("unrecoverable"),
      modifiedAt: new Date(fs.statSync(f.original).mtimeMs).toISOString(),
    });
    expect(selected.find((item) => item.path === capture)).toMatchObject({
      consequence: expect.stringContaining("all recovery generations"),
    });
    expect(fs.existsSync(f.original)).toBe(true);
    expect(fs.existsSync(capture)).toBe(true);
    await runRegisteredCli({ register: registerUpdateCli, argv: [...argv, "--yes", "--json"] });
    expect(report().status).toBe("complete");
    expect(report().totals.removedBytes).toBe(
      selected.reduce((bytes, item) => bytes + item.bytes, 0),
    );
    expect(fs.existsSync(f.original)).toBe(false);
    expect(fs.existsSync(capture)).toBe(false);
    expect(fs.readFileSync(f.other, "utf8")).toBe("other retained original");
  });
});

it("requires deletion consent independently of explicit selection and renders per-path consequences", async () => {
  const f = fixture();
  fs.utimesSync(
    f.original,
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T00:00:00.000Z"),
  );
  await withEnvAsync(f.env, async () => {
    using clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T00:00:00.000Z"));
    await updateCleanupCommand({ dryRun: true, includeUnmanifested: [f.original] });
    expect(vi.mocked(defaultRuntime.log).mock.calls.flat().join("\n")).toContain("modified 1d ago");
    expect(vi.mocked(defaultRuntime.log).mock.calls.flat().join("\n")).toContain(
      "pre-repair history, branches, and metadata may be unrecoverable",
    );
    clock.mockRestore();
    await expect(
      updateCleanupCommand({ json: true, includeUnmanifested: [f.original] }),
    ).rejects.toEqual(new ExitError(1));
    expect(report().status).toBe("refused");
    expect(fs.readFileSync(f.original, "utf8")).toBe("retained original");
  });
});

it.each([
  "outside",
  "symlink",
  "hardlink",
  "directory",
  "active-sibling",
  "wal",
  "live-database",
  "aliased-parent",
])("refuses unsafe explicit selection: %s", async (kind) => {
  const f = fixture();
  let selected = f.original;
  if (kind === "outside") {
    selected = path.join(f.home, "outside.pre-doctor-backup.bak");
    fs.writeFileSync(selected, "outside");
  } else if (kind === "symlink") {
    fs.unlinkSync(selected);
    fs.symlinkSync(f.other, selected);
  } else if (kind === "hardlink") {
    fs.linkSync(selected, path.join(f.home, "alias"));
  } else if (kind === "directory") {
    fs.unlinkSync(selected);
    fs.mkdirSync(selected);
  } else if (kind === "active-sibling") {
    fs.writeFileSync(`${selected}-wal`, "active WAL");
  } else if (kind === "wal") {
    selected += "-wal";
    fs.writeFileSync(selected, "active WAL");
  } else if (kind === "live-database") {
    selected = path.join(f.stateDir, "state", "openclaw.sqlite");
    // Deliberately absent: a live pathname cannot be admitted by explicit naming.
  } else {
    const alias = path.join(f.home, "alias-state");
    fs.symlinkSync(path.dirname(selected), alias);
    selected = path.join(alias, path.basename(selected));
  }
  await withEnvAsync(f.env, async () => {
    await expect(
      updateCleanupCommand({ yes: true, json: true, includeUnmanifested: [selected] }),
    ).rejects.toEqual(new ExitError(1));
    expect(report().status).toBe("blocked");
    if (kind !== "live-database") {
      expect(fs.existsSync(selected)).toBe(true);
    }
    expect(fs.readFileSync(f.other, "utf8")).toBe("other retained original");
  });
});

it.each(["symlink", "hardlink", "wal"])(
  "refuses an orphan capture containing a %s",
  async (kind) => {
    const f = fixture();
    const capture = orphan(f);
    const unsafe = path.join(capture, "payload", kind === "wal" ? "database-wal" : "unsafe");
    if (kind === "symlink") {
      fs.symlinkSync(f.other, unsafe);
    } else if (kind === "hardlink") {
      fs.linkSync(f.other, unsafe);
    } else {
      fs.writeFileSync(unsafe, "WAL");
    }
    expect(() => preview(f, [capture])).toThrow(/sidecar|hardlink|nonregular/);
    expect(fs.existsSync(unsafe)).toBe(true);
    expect(fs.readFileSync(f.other, "utf8")).toBe("other retained original");
  },
);

it.each(["direct", "aliased directory", "aliased manifest"])(
  "protects %s pending recovery references even when the capture has no matching update run",
  (kind) => {
    const f = fixture();
    const capture = orphan(f);
    let manifest = path.join(capture, "manifest.json");
    if (kind === "aliased directory") {
      const reference = path.join(f.home, "recovery-reference");
      fs.symlinkSync(capture, reference);
      manifest = path.join(reference, "manifest.json");
    } else if (kind === "aliased manifest") {
      const reference = path.join(f.home, "pending-manifest.json");
      fs.symlinkSync(manifest, reference);
      manifest = reference;
    }
    pendingRecovery(f, manifest);
    expect(() => preview(f, [capture])).toThrow(/pending or retained recovery/);
    expect(fs.existsSync(capture)).toBe(true);
  },
);

it.each(["replacement", "same-size-edit", "pending-reference", "new-sidecar"])(
  "rechecks explicit originals after confirmation: %s",
  async (change) => {
    const f = fixture();
    const initial = preview(f, [f.original]);
    await expect(
      retireSessionSqliteRecovery({
        env: f.env,
        preview: initial,
        includeUnmanifested: [f.original],
        readConfig: async () => ({}),
        confirm: async () => {
          if (change === "replacement") {
            fs.renameSync(f.original, path.join(f.home, "saved"));
            fs.writeFileSync(f.original, "retained original");
          } else if (change === "same-size-edit") {
            fs.writeFileSync(f.original, "modified original");
          } else if (change === "pending-reference") {
            pendingRecovery(f, f.original);
          } else {
            fs.writeFileSync(`${f.original}-shm`, "active index");
          }
          return true;
        },
      }),
    ).rejects.toThrow(/changed|pending|sidecar/);
    expect(fs.existsSync(f.original)).toBe(true);
    expect(fs.readFileSync(f.other, "utf8")).toBe("other retained original");
  },
);

it.each(["file replacement", "configured live store"])(
  "rechecks %s at the removal effect after progress callbacks",
  async (change) => {
    const f = fixture();
    let cfg: OpenClawConfig = {};
    const result = await retireSessionSqliteRecovery({
      env: f.env,
      preview: preview(f, [f.original]),
      includeUnmanifested: [f.original],
      readConfig: async () => cfg,
      confirm: async () => true,
      onProgress: ({ phase }) => {
        if (phase === "removing-unmanifested") {
          if (change === "file replacement") {
            fs.writeFileSync(f.original, "modified original");
          } else {
            cfg = { session: { store: f.original } };
          }
        }
      },
    });
    expect(result.status).toBe("blocked");
    expect(result.artifacts.find((item) => item.path === f.original)?.outcome).toBe("failed");
    expect(fs.readFileSync(f.original, "utf8")).toBe(
      change === "file replacement" ? "modified original" : "retained original",
    );
  },
);

it("refuses explicit cleanup while another Gateway owns the selected state", async () => {
  const f = fixture();
  const lock = await acquireGatewayLock({ env: f.env, allowInTests: true });
  expect(lock).not.toBeNull();
  try {
    await expect(
      retireSessionSqliteRecovery({
        env: f.env,
        preview: preview(f, [f.original]),
        includeUnmanifested: [f.original],
        readConfig: async () => ({}),
        confirm: async () => true,
      }),
    ).rejects.toThrow(/lock|Gateway/i);
    expect(fs.readFileSync(f.original, "utf8")).toBe("retained original");
  } finally {
    await lock?.release();
  }
});

it("retains a configured live store even when its name is classified as a recovery original", () => {
  const f = fixture();
  const cfg = { session: { store: f.original } };
  const inventory = collectUpdateCleanupInventory({ cfg, env: f.env });
  expect(inventory.report.artifacts.find((item) => item.path === f.original)?.reason).toBe(
    "unmanifested-recovery-original",
  );
  expect(() =>
    selectUnmanifestedRecovery({ inventory, paths: [f.original], cfg, env: f.env }),
  ).toThrow(/Active database path/);
  expect(fs.readFileSync(f.original, "utf8")).toBe("retained original");
});

it("refuses explicit retirement if stored recovery references cannot be decoded", () => {
  const f = fixture();
  const runId = pendingRecovery(f, path.join(f.home, "unrelated", "manifest.json"));
  openOpenClawStateDatabase({ env: f.env })
    .db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
    .run("unreadable", "update.recovery." + runId);
  closeOpenClawStateDatabaseForTest();
  expect(() => preview(f, [f.original])).toThrow();
  expect(fs.readFileSync(f.original, "utf8")).toBe("retained original");
});

it.each(["selection", "removal"] as const)(
  "refuses unresolved configuration at explicit %s",
  async (phase) => {
    const f = fixture();
    const include = path.join(f.stateDir, "selection.json");
    writeFixtureJsonSync(f.env.OPENCLAW_CONFIG_PATH, { $include: "selection.json" });
    writeFixtureJsonSync(include, phase === "selection" ? { session: { store: f.original } } : {});
    const hideInclude = () => fs.renameSync(include, `${include}.saved`);
    if (phase === "selection") {
      hideInclude();
    } else {
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        if (String(chunk).startsWith("Retiring explicitly selected original")) {
          hideInclude();
        }
        return true;
      });
    }
    await withEnvAsync(f.env, async () => {
      await expect(
        updateCleanupCommand({ yes: true, json: true, includeUnmanifested: [f.original] }),
      ).rejects.toEqual(new ExitError(1));
      expect(report().status).toBe("blocked");
      expect(fs.readFileSync(f.original, "utf8")).toBe("retained original");
    });
  },
);
