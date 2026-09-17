import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFreeBsdGatewayServiceDiscovery } from "../../daemon/freebsd-service.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  nativeFreeBsdRoot,
  withFreeBsdRootFixture,
} from "../../infra/update-freebsd-root-ownership.test-support.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as shared from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import * as packageUpdate from "./update-command-package.js";
import {
  admitUpdateCommandRun,
  completeUpdateCommandRun,
  createUpdateRunProgress,
  failUpdateCommandRun,
} from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import * as target from "./update-command-target.js";
import {
  deferUpdateCommandTerminalResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { updateCommand } from "./update-command.js";

const disposableGuest = nativeFreeBsdRoot && process.env.OPENCLAW_TEST_FREEBSD_DISPOSABLE === "1";
const reasons = {
  present: "freebsd-service-present",
  unknown: "freebsd-service-inspection-unavailable",
} as const;

afterEach(() => vi.restoreAllMocks());

async function withRcDefinition(status: keyof typeof reasons, operation: () => Promise<void>) {
  if (!disposableGuest) {
    throw new Error("Global rc fixtures require an explicitly marked disposable FreeBSD guest.");
  }
  expect(await readFreeBsdGatewayServiceDiscovery({})).toMatchObject({ status: "absent" });
  // This suite runs alone in the disposable guest: never replace an operator's
  // definition, execute a service, or remove a file whose ownership has changed.
  const filename = "/etc/rc.d/openclaw";
  const contents = `# disposable update admission fixture ${randomUUID()}\n`;
  const handle = await fs.open(filename, "wx", 0o600);
  const owned = await handle.stat();
  try {
    await handle.writeFile(contents);
    if (status === "unknown") {
      await handle.chmod(0o666);
    }
    expect(await readFreeBsdGatewayServiceDiscovery({})).toMatchObject(
      status === "present"
        ? { status: "present", definitions: [{ path: filename, executable: false }] }
        : { status: "unknown", reason: "unsafe-path-ownership" },
    );
    await operation();
  } finally {
    try {
      const current = await fs.lstat(filename);
      expect(current.isFile()).toBe(true);
      expect([current.dev, current.ino, current.uid]).toEqual([owned.dev, owned.ino, 0]);
      expect(await fs.readFile(filename, "utf8")).toBe(contents);
      await fs.unlink(filename);
      expect(await readFreeBsdGatewayServiceDiscovery({})).toMatchObject({ status: "absent" });
    } finally {
      await handle.close();
    }
  }
}

function isolatedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_SUPERVISOR_MODE: undefined,
    OPENCLAW_UPDATE_POST_CORE: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: undefined,
    ...env,
  };
}

describe.skipIf(!disposableGuest)(
  "global FreeBSD service eligibility",
  { concurrent: false },
  () => {
    it.each(["present", "unknown"] as const)(
      "refuses custom-state preparation and direct admission when rc state is %s",
      async (status) => {
        await withFreeBsdRootFixture(async ({ root, env }) => {
          await fs.writeFile(
            path.join(root, "package.json"),
            '{"name":"openclaw","version":"1.0.0"}',
          );
          vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
          const installProbe = vi.spyOn(updateCheck, "resolveUpdateInstallKind");
          const serviceProbe = vi.spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan");
          const select = vi.spyOn(target, "resolveUpdateCommandTarget");
          const initialize = vi.spyOn(packageUpdate, "runPackageUpdateDoctor");
          const stage = vi.spyOn(packageUpdate, "stagePackageInstallUpdate");
          const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
          const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
          await withEnvAsync(isolatedEnv(env), async () => {
            await withRcDefinition(status, async () => {
              const exit = await updateCommand({ restart: false, yes: true, json: true }).catch(
                (failure: unknown) => failure,
              );
              expect(exit).toBeInstanceOf(ExitError);
              expect(exit).toMatchObject({ code: 1 });
              expect(output).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ status: "error", reason: reasons[status] }),
              );
              expect(error).toHaveBeenCalledWith(
                expect.stringContaining(
                  status === "present" ? "existing definition was found" : "unsafe-path-ownership",
                ),
              );
              await expect(
                admitUpdateCommandRun({ root, opts: { restart: false } }),
              ).rejects.toMatchObject({ reason: reasons[status] });
              for (const probe of [installProbe, serviceProbe, select, initialize, stage]) {
                expect(probe).not.toHaveBeenCalled();
              }
              await expect(fs.stat(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
                code: "ENOENT",
              });
              await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
                code: "ENOENT",
              });
            });
          });
        });
      },
      60_000,
    );

    it.each(["present", "unknown"] as const)(
      "keeps the first %s refusal after an admitted executor loses global absence",
      async (status) => {
        await withFreeBsdRootFixture(async ({ home, root, env }) => {
          await fs.writeFile(
            path.join(root, "package.json"),
            '{"name":"openclaw","version":"1.0.0"}',
          );
          const control = path.join(home, "executor-control");
          await fs.mkdir(control, { mode: 0o700 });
          vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
          vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
          await withEnvAsync(isolatedEnv(env), async () => {
            const run = await admitUpdateCommandRun({ root, opts: { restart: false } });
            const admission = run.freebsdRootAdmission!;
            const before = getUpdateRun(run.runId, { env: run.env });
            expect(admission.canWrite).toBe(true);
            const publications: string[] = [];
            const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {
              publications.push(createManagedHandoffLeaseStore().read(root).kind);
            });
            const publish = vi.fn(async () => ({
              status: "ok" as const,
              mode: "npm" as const,
              root,
              steps: [],
              durationMs: 1,
            }));
            let terminalFailure: unknown;
            const execute = () =>
              withUpdateCommandExecutor(run.runId, async (executor) => {
                run.executorFence = await executor.enter(root);
                const revalidate = () =>
                  admission.revalidate({ roots: [root], env }, run.executorFence!.assertCurrent);
                let firstFailure: unknown;
                await withRcDefinition(status, async () => {
                  await expect(revalidate()).rejects.toMatchObject({ reason: reasons[status] });
                  firstFailure = admission.failure;
                  expect(firstFailure).toBeInstanceOf(Error);
                  expect(admission.canWrite).toBe(false);
                  const progress = createUpdateRunProgress(run, {});
                  expect(() => {
                    progress.onHeartbeat?.();
                    progress.onStepStart?.({
                      name: "late callback",
                      command: "fixture",
                      index: 0,
                      total: 1,
                    });
                    progress.flushLedgerWrites();
                    failUpdateCommandRun(new Error("later diagnostic"), run);
                  }).not.toThrow();
                  expect(
                    completeUpdateCommandRun(
                      { status: "ok", mode: "npm", root, steps: [], durationMs: 1 },
                      run,
                    ),
                  ).toMatchObject({ status: "error", reason: reasons[status] });
                  expect(defaultRuntime.error).toHaveBeenCalledWith(
                    expect.stringContaining((firstFailure as Error).message),
                  );
                  expect(getUpdateRun(run.runId, { env: run.env })).toEqual(before);
                });
                // Restored absence cannot revive the rejected run or replace its
                // first native refusal with the later generic ownership error.
                await expect(revalidate()).rejects.toBe(firstFailure);
                expect(admission.failure).toBe(firstFailure);
              });
            const exit = await withUpdateFailureTriage(
              { run, json: true },
              { env: run.env },
              async () => {
                try {
                  await withUpdateCommandTerminalResult(
                    async (register) => {
                      register(run);
                      expect(deferUpdateCommandTerminalResult(run, publish)).toBe(true);
                      await execute();
                    },
                    { json: true },
                  );
                } catch (error) {
                  terminalFailure = error;
                  throw error;
                }
              },
            ).catch((error: unknown) => error);
            expect(exit).toBeInstanceOf(ExitError);
            expect(exit).toMatchObject({ code: 1 });
            expect(terminalFailure).toMatchObject({
              result: { reason: reasons[status], runId: run.runId },
              detail: expect.stringContaining(admission.failure!.message),
            });
            // Reporting must not mask an assertion or fixture cleanup failure
            // thrown inside the executor after admission was revoked.
            expect((terminalFailure as Error).cause).toBeUndefined();
            expect(publish).not.toHaveBeenCalled();
            expect(publications).toEqual(["absent"]);
            expect(output).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                status: "error",
                reason: reasons[status],
                runId: run.runId,
              }),
            );
            expect(getUpdateRun(run.runId, { env: run.env })).toEqual(before);
          });
        });
      },
      60_000,
    );
  },
);
