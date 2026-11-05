import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, expect, it, vi } from "vitest";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import { assertGatewayServiceUpdateCurrent } from "../../daemon/service-update-authority.js";
import { readGatewayServiceState } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as processRunner from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";

const fixture = useExecutorFixture("native-inspection-", { splitRoots: true });
const command = { programArguments: ["node", "gateway"] };
const runtime = { status: "stopped" as const, managerUid: 1001 };

it.skipIf(process.platform === "win32").each([
  ["command-present", null],
  ["command-absent", null],
  ["requester-revoked", "requester revoked"],
  ["fence-reassigned", "Retained service lost its original executor."],
  ["A-revoked", "Update failed and executor release remains pending"],
  ["B-revoked", "Update failed and executor release remains pending"],
  ["cleanup-uncertain", "Command cleanup could not confirm that owned work stopped"],
] as const)(
  "joins native inspection before parent reads: %s",
  async (change, failure) => {
    const { root, serviceRoot, control } = fixture();
    const healthy = failure === null;
    const runCommand = processRunner.runCommandWithTimeout;
    const bound = createDeferredCore();
    const runId = randomUUID();
    let current = true;
    let nativeReads = 0;
    let parentReads = 0;
    const work = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId,
        env: {},
        executorFence: fence,
      };
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        assert(typeof options !== "number");
        const result = await runCommand(
          argv,
          healthy
            ? {
                ...options,
                beforeInput(pid, spawnedArgv) {
                  options.beforeInput?.(pid, spawnedArgv);
                  expect(() => fence.assertCurrent()).toThrow(
                    "The update process is still running.",
                  );
                  bound.resolve();
                },
              }
            : options,
        );
        expect(result).toMatchObject({ code: 0, termination: "exit" });
        nativeReads++;
        if (change === "requester-revoked") {
          current = false;
        }
        if (change === "fence-reassigned") {
          run.executorFence = { assertCurrent() {} };
        }
        if (change === "A-revoked" || change === "B-revoked") {
          using db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
          const changed = db
            .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
            .run("replacement", change === "A-revoked" ? serviceRoot : root);
          expect(changed.changes).toBe(1);
        }
        // The native child settled; only the negative cleanup classification is injected.
        return change === "cleanup-uncertain" ? { ...result, cleanup: "uncertain" } : result;
      });
      const nativeRead = async () => {
        const result = await execFileUtf8(
          process.execPath,
          ["-e", 'process.stdout.write("loaded");'],
          { timeout: 5000 },
        );
        expect(result).toMatchObject({ code: 0, stdout: "loaded" });
        return true;
      };
      const service = createMockGatewayService({
        readCommand: async () => (change === "command-absent" ? null : command),
        hasInstalledDefinition: nativeRead,
        isLoaded: nativeRead,
        readRuntime: async () => {
          if (healthy) {
            await bound.promise;
          }
          assertGatewayServiceUpdateCurrent();
          parentReads++;
          return runtime;
        },
      });
      const state = await withRetainedUpdateServiceAuthority(
        {
          run,
          root: serviceRoot,
          assertCurrent: () => {
            if (!current) {
              throw new Error("requester revoked");
            }
          },
        },
        () =>
          readGatewayServiceState(service, { env: {}, requireEffective: true, timeoutMs: 5000 }),
      );
      expect(state).toMatchObject({ loadState: { status: "loaded" }, runtime, installed: true });
      fence.assertCurrent();
    });
    if (healthy) {
      await work;
    } else {
      await expect(work).rejects.toThrow(failure);
      expect(parentReads).toBe(0);
    }
    expect(nativeReads).toBe(change === "command-absent" ? 2 : 1);
  },
  15000,
);
