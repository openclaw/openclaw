import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as groups from "../process/child-process-tree.js";
import * as settlement from "../process/command-process-custody.js";
import type { CommandProcessIdentity } from "../process/command-process-custody.types.js";
import * as termination from "../process/kill-tree.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createUpdateDoctorProcessCustody } from "./update-doctor-process-custody.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "./update-doctor-result.js";
import { createManagedCommandProcessCustody } from "./update-managed-command-custody.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform !== "linux")(
  "joins a recorded Doctor group without synchronous procfs reads or premature retirement",
  async ({ signal: testSignal }) => {
    const root = fs.realpathSync(directories.make("doctor-recorded-settlement-"));
    const resultPath = path.join(root, "result.json");
    const receiptPath = `${resultPath}.processes`;
    const native = await createManagedCommandProcessCustody({
      roots: [root],
      runId: "recorded-group",
      databasePath: path.join(root, "handoffs.sqlite"),
    });
    const parent = await createUpdateDoctorProcessCustody("recorded-group", root, resultPath, {
      roots: [root],
      databaseIdentity: native.databaseIdentity,
    });
    const store = createManagedHandoffLeaseStore({
      databasePath: native.databasePath,
      existingIdentity: native.databaseIdentity,
      serviceManagerEnv: {},
    });
    const doctor = spawn(
      process.execPath,
      [
        "--import",
        new URL("../../scripts/tsx.mjs", import.meta.url).href,
        "--input-type=module",
        "-e",
        "import { spawn } from 'node:child_process';" +
          "import { once } from 'node:events';" +
          "import { retainUpdateDoctorProcesses } from " +
          JSON.stringify(new URL("./update-doctor-process-custody.ts", import.meta.url).href) +
          ";" +
          "import { getProcessInstanceStartTime } from " +
          JSON.stringify(new URL("../shared/pid-alive.ts", import.meta.url).href) +
          ";" +
          "const custody = await retainUpdateDoctorProcesses();" +
          "const argv = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];" +
          "const slot = custody.reserve(argv);" +
          "const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });" +
          "await once(child, 'spawn'); const identity = { pid: child.pid, startedAt: getProcessInstanceStartTime(child.pid) };" +
          "slot.spawned(identity); child.unref();",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: resultPath },
      },
    );
    let stderr = "";
    doctor.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(doctor, "close");
    expect(code, stderr).toBe(0);
    const receipt: { slots: { identity: CommandProcessIdentity }[] } = JSON.parse(
      fs.readFileSync(receiptPath, "utf8"),
    );
    const identity = receipt.slots[0]!.identity;
    const kill = termination.killProcessTree;
    const requested = createDeferredCore();
    const signal = vi.spyOn(termination, "killProcessTree").mockImplementation((pid, options) => {
      if (pid !== identity.pid) {
        throw new Error("Unexpected process signal");
      }
      expect(options).toEqual({ detached: true, force: true });
      // Hold the private group's signal until the test checks retained custody.
      requested.resolve();
    });
    const observing = new AsyncLocalStorage<boolean>();
    const settle = settlement.settleCommandProcessGroups;
    vi.spyOn(settlement, "settleCommandProcessGroups").mockImplementation(async (identities) => {
      return await observing.run(true, () => settle(identities));
    });
    const syncProcReads: string[] = [];
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (observing.getStore() && String(file).startsWith("/proc/")) {
        syncProcReads.push(String(file));
      }
      return read(file, options);
    });
    let completed = false;
    const pending = parent
      .settle({ pid: doctor.pid, code: 124, cleanup: "forced", termination: "timeout" })
      .then((result) => {
        completed = true;
        return result;
      });
    try {
      await withinTest(
        awaitGateBeforeSettlement(requested.promise, pending, "Recorded group was not signaled"),
        testSignal,
      );
      expect(groups.isChildProcessTreeAlive(identity)).toBe(true);
      expect(completed).toBe(false);
      expect(store.readCommandChildren([root])).toHaveLength(1);
      parent.close();
      expect(fs.existsSync(receiptPath)).toBe(true);
      signal.mockRestore();
      kill(identity.pid, { detached: true, force: true });
      const result = await pending;
      expect(result).toMatchObject({ exitCode: 0 });
      expect(groups.isChildProcessTreeAlive(identity)).toBe(false);
      expect(store.readCommandChildren([root])).toEqual([]);
      parent.close();
      expect(fs.existsSync(receiptPath)).toBe(false);
      expect(syncProcReads).toEqual([]);
    } finally {
      signal.mockRestore();
      kill(identity.pid, { detached: true, force: true });
      await pending;
      native.releaseAnchors();
    }
  },
);
