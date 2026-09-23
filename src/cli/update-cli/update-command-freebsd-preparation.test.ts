import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { nativeFreeBsd, withFreeBsdFixture } from "../../infra/update-freebsd.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
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

it.skipIf(!nativeFreeBsd)("refuses a managed-service handoff before state creation", async () => {
  await withFreeBsdFixture(async ({ root, env }) => {
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
    await withEnvAsync(isolatedEnv({ ...env, OPENCLAW_UPDATE_RUN_HANDOFF: "1" }), async () => {
      await expect(prepareUpdateCommand({})).rejects.toMatchObject({
        reason: "freebsd-update-mode",
      });
    });
    await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it
  .skipIf(!nativeFreeBsd)
  .each(["api", "campaign", "missing run", "mismatched run", "post-core without run"] as const)(
  "refuses inherited %s before preparation or adoption changes selected state",
  async (request) => {
    await withFreeBsdFixture(async ({ root, env }) => {
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

it.skipIf(!nativeFreeBsd)(
  "preserves an existing manual CLI run through explicit no-restart post-core preparation",
  async () => {
    await withFreeBsdFixture(async ({ root, env }) => {
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
          expect(prepared.freebsdWriteAdmission?.canWrite).toBe(false);
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

it.skipIf(!nativeFreeBsd).each([
  { restart: undefined, dryRun: false },
  { restart: true, dryRun: false },
  { restart: false, dryRun: false },
  { restart: undefined, dryRun: true },
])(
  "admits the invoking user's selected state: restart=$restart dryRun=$dryRun",
  async (opts) => {
    await withFreeBsdFixture(async ({ home, root, env }) => {
      const control = path.join(home, "executor-control");
      await fs.mkdir(control, { mode: 0o700 });
      vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      );
      await withEnvAsync(isolatedEnv(env), async () => {
        vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
        const prepared = await prepareUpdateCommand(opts);
        expect(prepared.shouldRestart).toBe(opts.restart !== false);
        expect(prepared.freebsdWriteAdmission?.canWrite).toBe(false);
        const run = await admitUpdateCommandRun({
          root,
          opts,
          freebsdWriteAdmission: prepared.freebsdWriteAdmission,
        });
        expect(run.env.OPENCLAW_STATE_DIR).toBe(env.OPENCLAW_STATE_DIR);
        expect(run.env.OPENCLAW_CONFIG_PATH).toBe(env.OPENCLAW_CONFIG_PATH);
        expect(run.freebsdWriteAdmission?.canWrite).toBe(true);
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
