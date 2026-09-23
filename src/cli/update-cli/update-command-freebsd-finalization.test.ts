import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createFreeBsdUpdateWriteAdmission } from "../../infra/update-freebsd-write-admission.js";
import { nativeFreeBsd, withFreeBsdFixture } from "../../infra/update-freebsd.test-support.js";
import * as updateGlobal from "../../infra/update-global.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import * as execution from "./update-command-execution.js";
import {
  createSelectedTargetStateDatabase,
  installFreshUpdateFixture,
  targetDoctorSuccess,
} from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import {
  deferUpdateCommandTerminalResult,
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

it.skipIf(!nativeFreeBsd).each(["execution", "staged cleanup"])(
  "keeps history pending after native rejection during %s and still releases the stage and executor",
  async (boundary) => {
    await withFreeBsdFixture(async ({ home, root, env }) => {
      fixture.root = root;
      fixture.databasePath = resolveOpenClawStateSqlitePath(env);
      for (const name of ["OPENCLAW_HOME", "OPENCLAW_PROFILE", "OPENCLAW_SUPERVISOR_MODE"]) {
        vi.stubEnv(name, undefined);
      }
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
      );
      const control = path.join(home, "executor-control");
      await fs.mkdir(control, { mode: 0o700 });
      vi.mocked(tempRoot.resolvePreferredOpenClawTmpDir).mockReturnValue(control);
      vi.mocked(processIdentity.getFileLockProcessStartTime).mockRestore();
      vi.mocked(updateGlobal.createGlobalInstallEnv).mockResolvedValue({ ...process.env });
      vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockResolvedValue({
        manager: "npm",
        command: "npm",
        globalRoot: home,
        packageRoot: root,
        npmOwner: { version: "11.10.0", lifecyclePolicy: "unflagged" },
      });
      const prepare = vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation()!;
      vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (opts) => ({
        ...(await prepare(opts)),
        freebsdWriteAdmission: createFreeBsdUpdateWriteAdmission(),
      }));
      vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
        ok: true,
        value: {},
      });
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`fixture CLI exit ${code}`);
      });
      vi.spyOn(packageUpdate, "runPackageUpdateDoctor").mockImplementation(async () => {
        createSelectedTargetStateDatabase(fixture.databasePath);
        return targetDoctorSuccess;
      });
      let run: NonNullable<UpdateCommandOptions["run"]> | undefined;
      let before: ReturnType<typeof getUpdateRun>;
      const revoke = async () => {
        if (!run?.freebsdWriteAdmission || !run.executorFence) {
          throw new Error("admitted executor missing");
        }
        throw run.freebsdWriteAdmission.revoke(new Error("fixture executor authority revoked"));
      };
      let stageSettled = false;
      const observations: { stageSettled: boolean; lease: string }[] = [];
      const staged = {
        root,
        run: vi.fn(),
        close: vi.fn(async () => {
          try {
            if (boundary === "staged cleanup") {
              await revoke();
            }
          } finally {
            stageSettled = true;
          }
        }),
      };
      vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
        observations.push({
          stageSettled,
          lease: createManagedHandoffLeaseStore().read(root).kind,
        });
      });
      vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
      const publish = vi.fn(async (failure?: unknown) => {
        const settled = await resolveSettledUpdateCommandResult(
          { opts: { run }, root },
          { status: "ok", mode: "npm", root, steps: [], durationMs: 1 },
          failure,
        );
        return publishUpdateCommandTerminalResult({ opts: { run } }, settled.result, {
          rolledBack: false,
        });
      });
      vi.spyOn(execution, "executeMutableUpdate").mockImplementation(async (params) => {
        run = params.opts.run;
        if (!run) {
          throw new Error("update run missing");
        }
        before = getUpdateRun(run.runId, { env: run.env });
        if (boundary === "execution") {
          await revoke();
        }
        expect(deferUpdateCommandTerminalResult(run, publish)).toBe(true);
        return null;
      });
      await expect(
        updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: false }),
      ).rejects.toThrow();
      expect(execution.executeMutableUpdate).toHaveBeenCalledOnce();
      expect(staged.close).toHaveBeenCalledOnce();
      expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
      expect(publish).not.toHaveBeenCalled();
      expect(run?.freebsdWriteAdmission?.canWrite).toBe(false);
      expect(before?.status).toBe("running");
      expect(getUpdateRun(run!.runId, { env: run!.env })).toEqual(before);
      expect(observations).toEqual([{ stageSettled: true, lease: "absent" }]);
      expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          reason: "freebsd-update-ownership",
          runId: run!.runId,
        }),
      );
    });
  },
  60_000,
);
