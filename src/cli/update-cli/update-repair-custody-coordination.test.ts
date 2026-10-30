// Register shared mocks before importing the production CLI graph.
import "./update-repair.test-support.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../../test/helpers/managed-handoff-isolation.js";
import { writePrivateUpdateHandoffChildGuard } from "../../../test/helpers/private-update-handoff-store.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as census from "../../infra/openclaw-process-census.js";
import { resolvePackageActivationJournalPath } from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
} from "../../infra/package-update-activation.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "../../infra/update-managed-service-handoff-database.js";
import * as handoffLease from "../../infra/update-managed-service-handoff-lease.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { killPidIfAlive, waitForPidToExit } from "../../test-utils/process-tree.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { registerUpdateCli } from "../update-cli.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

const { createRepairState, mocks } = await import("./update-repair.test-support.js");

vi.mock("../../infra/update-check.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-check.js")>()),
  resolveUpdateInstallKind: async () => "package",
}));

// Bound candidate process groups and SIGKILL are POSIX custody facts.
const unix = process.platform === "win32" ? it.skip : it;
const fixtures = createPackageActivationLifetimeFixture();
let state: OpenClawTestState;
let f: Awaited<ReturnType<(typeof fixtures)["prepare"]>>;
let privateTmp: string;
let databasePath: string;
let candidate: number | undefined;
let censusMatches: number[] = [];

beforeEach(async () => {
  state = await createRepairState("repair-custody-coordination", {
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    OPENCLAW_UPDATE_POST_CORE: undefined,
  });
  const setup = fixtures.setup();
  privateTmp = path.join(setup.root, "private-tmp");
  databasePath = handoffLease.resolveManagedUpdateLeaseDatabasePath();
  expect(databasePath).toContain(privateTmp);
  vi.spyOn(os, "tmpdir").mockReturnValue(privateTmp);
  f = await fixtures.prepare();
  // Repair targets the journal's own installation so one key holds both states.
  mocks.root.mockResolvedValue(f.packageRoot);
});

afterEach(async () => {
  killPidIfAlive(candidate);
  vi.restoreAllMocks();
  await fixtures.lifetime.cleanup();
  await state.cleanup();
});

function rows() {
  return createManagedHandoffLeaseDatabase(databasePath)(false, (db) =>
    executeSqliteQuerySync(
      db,
      leaseQueries(db).selectFrom("managed_update_handoffs").selectAll().orderBy("install_root"),
    ),
  ).rows;
}

/**
 * A real original executor binds a candidate, cancels, and dies by SIGKILL,
 * leaving retained lease-v4 custody on the journal's own installation.
 */
function crashPackageRoot() {
  const pidFile = path.join(privateTmp, "candidate.pid");
  const script = path.join(privateTmp, "cancelled-original.mts");
  const url = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
  const binding = createManagedHandoffTestBinding(privateTmp);
  const guardEnv = writePrivateUpdateHandoffChildGuard(databasePath, privateTmp);
  fs.writeFileSync(
    script,
    `
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
createRequire(import.meta.url)(${JSON.stringify(path.join(privateTmp, "private-handoff-guard.cjs"))});
const now = Date.now;
Date.now = () => now() - 50 * 60_000;
const executor = await import(${url("./update-command-executor.ts")});
const { createUpdateRun } = await import(${url("../../infra/update-run-ledger.ts")});
const { readUpdateRunDriver } = await import(${url("../../infra/update-run-driver.ts")});
const run = createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver(), admission: { owner: "installed" } } });
await executor.withUpdateCommandExecutor(run.runId, async (owner) => {
  const fence = await owner.enter(${JSON.stringify(f.packageRoot)});
  await executor.withUpdateCommandExecutorChild(fence, ${JSON.stringify(f.packageRoot)}, async (_grant, bindChild) => {
    const candidate = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    bindChild(candidate.pid);
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(candidate.pid));
    executor.requestUpdateCommandExecutorCancellation(fence, run.runId, new Error("activation deadline"));
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  });
});
`,
  );
  // Host census is the only synthetic observation; process and SQLite custody stay real.
  censusMatches = [];
  const censusSpy = vi
    .spyOn(census, "inspectOtherOpenClawProcesses")
    .mockImplementation(((references?: { runId: string }) => {
      if (typeof references !== "object") {
        return { pids: [] };
      }
      return { matchingPids: censusMatches.splice(0), unverifiedPids: [] };
    }) as typeof census.inspectOtherOpenClawProcesses);
  const result = spawnSync(
    resolveTestNodeExecPath(),
    ["--import", "tsx", binding.nodeOption, script],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: guardEnv({ ...process.env, TMPDIR: privateTmp }),
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
    },
  );
  censusSpy.mockRestore();
  expect([result.error, result.signal], result.stderr).toEqual([undefined, "SIGKILL"]);
  candidate = Number(fs.readFileSync(pidFile, "utf8"));
  const family = rows();
  const original = family[0];
  assert(original?.install_root === f.packageRoot, "Missing cancelled original");
  expect(JSON.parse(original.payload_json)).toMatchObject({ version: 4 });
  expect(family.map((row) => row.install_root)).toHaveLength(2);
  return { original };
}

async function stopCandidate() {
  killPidIfAlive(candidate);
  expect(await waitForPidToExit(candidate!, 10_000)).toBe(true);
}

function repair() {
  return withCliProcessScope(() =>
    runRegisteredCli({
      register: registerUpdateCli,
      argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
    }),
  );
}

function admit(runId: string) {
  return withUpdateCommandExecutor(runId, async (executor) => {
    const fence = await executor.enter(f.packageRoot);
    fence.assertCurrent();
    return "admitted";
  });
}

function lastJson() {
  return vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
}

unix(
  "repair settles custody blocking an untouched package journal, then the journal settles on the next run",
  { timeout: 120_000 },
  async () => {
    crashPackageRoot();
    await stopCandidate();

    // A package journal and retained cancelled custody coexist on one install:
    // package settlement requests fresh ownership first and hits the custody
    // fence, which dead-ended the repair before custody settlement could run.
    await expect(repair()).rejects.toThrow("retains cancelled update custody");
    expect(rows()).toHaveLength(2);
    expect(fs.existsSync(resolvePackageActivationJournalPath(f.anchor))).toBe(true);

    await repair();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(lastJson()).toMatchObject({ status: "ok" });
    expect(lastJson()).not.toHaveProperty("retainedUpdateCustody");
    expect(vi.mocked(defaultRuntime.error).mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("retained cancelled update custody prevented package settlement"),
      ]),
    );
    // The custody family is settled and the next update's executor admits.
    expect(rows()).toEqual([]);
    await expect(admit("next-update")).resolves.toBe("admitted");
    // The untouched package journal stays protected until its own clean window.
    expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "prepared" });

    // The follow-up repair settles the eligible journal without any custody.
    vi.mocked(defaultRuntime.writeJson).mockClear();
    await repair();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(lastJson()).toMatchObject({ status: "ok" });
    expect(fs.existsSync(resolvePackageActivationJournalPath(f.anchor))).toBe(false);
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    expect(rows()).toEqual([]);
  },
);
