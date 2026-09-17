import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as nativeService from "../../daemon/freebsd-service.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  nativeFreeBsdRoot,
  withFreeBsdRootFixture,
} from "../../infra/update-freebsd-root-ownership.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as shared from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  admitUpdateCommandRun,
  completeUpdateCommandRun,
  prepareUpdateCommand,
} from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

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

it.skipIf(!nativeFreeBsdRoot).each(["default restart", "explicit restart", "managed handoff"])(
  "reports and refuses %s before root inspection or state creation",
  async (request) => {
    await withFreeBsdRootFixture(async ({ root, env }) => {
      const opts = {
        json: true,
        yes: true,
        restart: request === "default restart" ? undefined : request === "explicit restart",
      };
      const rootProbe = vi.spyOn(shared, "resolveUpdateRoot");
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      await withEnvAsync(
        isolatedEnv({
          ...env,
          OPENCLAW_UPDATE_RUN_HANDOFF: request === "managed handoff" ? "1" : undefined,
        }),
        async () => {
          const exit = await updateCommand(opts).catch((error: unknown) => error);
          expect(exit).toBeInstanceOf(ExitError);
          expect(exit).toMatchObject({ code: 1 });
          expect(output).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ status: "error", reason: "freebsd-update-mode" }),
          );
          expect(errors).toHaveBeenCalledWith(expect.stringContaining("--no-restart"));
          await expect(admitUpdateCommandRun({ root, opts })).rejects.toMatchObject({
            reason: "freebsd-update-mode",
          });
        },
      );
      expect(rootProbe).not.toHaveBeenCalled();
      await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(env.OPENCLAW_CONFIG_PATH!)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

it
  .skipIf(!nativeFreeBsdRoot)
  .each(["api", "campaign", "missing run", "mismatched run", "post-core without run"] as const)(
  "refuses inherited %s before preparation or adoption changes selected state",
  async (request) => {
    await withFreeBsdRootFixture(async ({ root, env }) => {
      const created =
        request === "missing run" || request === "post-core without run"
          ? undefined
          : createUpdateRun(
              { trigger: request === "api" || request === "campaign" ? request : "cli" },
              { env },
            );
      closeOpenClawStateDatabaseForTest();
      const database = resolveOpenClawStateSqlitePath(env);
      const before = created ? await fs.readFile(database) : undefined;
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
      const installProbe = vi.spyOn(updateCheck, "resolveUpdateInstallKind");
      const opts: shared.UpdateCommandOptions = {
        restart: false,
        ...(request === "mismatched run" ? { run: { runId: "another-run", env } } : {}),
      };
      await withEnvAsync(
        isolatedEnv({
          ...env,
          OPENCLAW_UPDATE_RUN_ID:
            request === "post-core without run" ? undefined : (created?.runId ?? "missing-run"),
          OPENCLAW_UPDATE_POST_CORE: "1",
        }),
        async () => {
          await expect(prepareUpdateCommand(opts)).rejects.toMatchObject({
            reason: "freebsd-update-mode",
          });
          await expect(admitUpdateCommandRun({ root, opts })).rejects.toMatchObject({
            reason: "freebsd-update-mode",
          });
        },
      );
      expect(installProbe).not.toHaveBeenCalled();
      if (created) {
        expect(await fs.readFile(database)).toEqual(before);
        expect(getUpdateRun(created.runId, { env })).toEqual(created);
      } else {
        await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(fs.stat(env.OPENCLAW_CONFIG_PATH!)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
  60_000,
);

it.skipIf(!nativeFreeBsdRoot)(
  "preserves an existing manual CLI run through explicit no-restart post-core preparation",
  async () => {
    await withFreeBsdRootFixture(async ({ root, env }) => {
      await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
      const created = createUpdateRun({ trigger: "cli" }, { env });
      closeOpenClawStateDatabaseForTest();
      const before = await fs.readFile(resolveOpenClawStateSqlitePath(env));
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
      await withEnvAsync(
        isolatedEnv({
          ...env,
          OPENCLAW_UPDATE_RUN_ID: created.runId,
          OPENCLAW_UPDATE_POST_CORE: "1",
        }),
        async () => {
          const prepared = await prepareUpdateCommand({ restart: false });
          expect(prepared).toMatchObject({ postCoreUpdateResume: true, shouldRestart: false });
          expect(prepared.freebsdRootAdmission?.canWrite).toBe(true);
          expect(getUpdateRun(created.runId, { env })).toEqual(created);
          expect(await fs.readFile(resolveOpenClawStateSqlitePath(env))).toEqual(before);
          const run = await admitUpdateCommandRun({ root, opts: { restart: false } });
          expect(run.runId).toBe(created.runId);
          expect(getUpdateRun(run.runId, { env })).toMatchObject({ trigger: "cli" });
        },
      );
    });
  },
  60_000,
);

it.skipIf(!nativeFreeBsdRoot).each(["installation", "HOME", "state", "config"])(
  "refuses foreign %s before preparation probes or history creation",
  async (target) => {
    await withFreeBsdRootFixture(async ({ home, root, env }) => {
      const selected =
        target === "installation"
          ? root
          : target === "HOME"
            ? path.join(home, "foreign-home")
            : target === "state"
              ? env.OPENCLAW_STATE_DIR!
              : env.OPENCLAW_CONFIG_PATH!;
      if (target === "config") {
        await fs.writeFile(selected, "{}", { mode: 0o600 });
      } else {
        await fs.mkdir(selected, { recursive: true, mode: 0o700 });
      }
      await fs.chown(selected, 65534, 65534);
      if (target === "HOME") {
        env.HOME = selected;
      }
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
      const installProbe = vi.spyOn(updateCheck, "resolveUpdateInstallKind");
      const serviceProbe = vi.spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan");
      await withEnvAsync(isolatedEnv(env), async () => {
        await expect(prepareUpdateCommand({ restart: false })).rejects.toMatchObject({
          reason: "freebsd-update-ownership",
        });
      });
      expect(installProbe).not.toHaveBeenCalled();
      expect(serviceProbe).not.toHaveBeenCalled();
      expect((await fs.lstat(selected)).uid).toBe(65534);
      await expect(fs.stat(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
  30_000,
);

it.skipIf(!nativeFreeBsdRoot)(
  "admits explicit root-owned state with fresh native absence",
  async () => {
    await withFreeBsdRootFixture(async ({ home, root, env }) => {
      const control = path.join(home, "executor-control");
      await fs.mkdir(control, { mode: 0o700 });
      vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      );
      await withEnvAsync(isolatedEnv(env), async () => {
        const discovery = vi.spyOn(nativeService, "readFreeBsdGatewayServiceDiscovery");
        const run = await admitUpdateCommandRun({ root, opts: { restart: false } });
        // The real admission owner must consume fresh absence even though this
        // custom state has no permission to manage the native service.
        expect(discovery).toHaveBeenCalled();
        for (const result of discovery.mock.results) {
          await expect(result.value).resolves.toMatchObject({ status: "absent" });
        }
        expect(run.env.OPENCLAW_STATE_DIR).toBe(env.OPENCLAW_STATE_DIR);
        expect(run.env.OPENCLAW_CONFIG_PATH).toBe(env.OPENCLAW_CONFIG_PATH);
        expect(run.freebsdRootAdmission?.canWrite).toBe(true);
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(root);
          run.executorFence.assertCurrent();
          expect(
            completeUpdateCommandRun(
              { status: "ok", mode: "npm", root, steps: [], durationMs: 1 },
              run,
            ).status,
          ).toBe("ok");
        });
        expect(getUpdateRun(run.runId, { env: run.env })).toMatchObject({
          trigger: "cli",
          status: "succeeded",
        });
      });
    });
  },
  60_000,
);
