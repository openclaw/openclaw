import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  defaultPayload,
  StateDatabaseOfflineMaintenanceError,
} from "../../infra/gateway-state-owner-record.js";
import * as ownerRecord from "../../infra/gateway-state-owner-record.js";
import { resolveGatewayStateOwnerPath } from "../../infra/gateway-state-owner.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  successfulPluginUpdate,
  managedServiceState,
} from "./update-command-post-update.test-support.js";
import { resolveMutableUpdateFailure } from "./update-command-result.js";
import * as service from "./update-command-service.js";
import { createPostUpdateExceptionResult } from "./update-command-terminal-publication.js";
import { resolveSettledUpdateCommandResult } from "./update-command-terminal.js";

const healthyRecovery = { serviceRestartSafe: true as const, version: "2026.10.3" };
const packageResult = () => ({
  status: "ok" as const,
  mode: "npm" as const,
  after: { version: "2026.10.3" },
  steps: [],
  durationMs: 1,
});

export function registerMaintenanceContentionTests(
  makeHome: () => string,
  mocks: {
    readConfig: Mock;
    completePluginUpdate: Mock;
    restartService: Mock;
    printResult: Mock;
    readServiceState: Mock;
  },
) {
  it.each([false, true])(
    "managed npm finalization tolerates child maintenance (expires=%s)",
    async (expires) => {
      const identity = createManagedServiceIdentityFixture(makeHome());
      const env = { ...process.env, OPENCLAW_STATE_DIR: identity.home };
      const databasePath = resolveOpenClawStateSqlitePath(env);
      openOpenClawStateDatabase({ env });
      closeOpenClawStateDatabaseForTest();
      const writeJson = (file: string, data: unknown) =>
        fs.writeFile(path.join(identity.home, file), JSON.stringify(data));
      await writeJson("openclaw.json", { gateway: { mode: "local", port: 19301 } });
      await writeJson("package.json", { name: "openclaw", version: "2026.10.3" });
      const ownerPath = resolveGatewayStateOwnerPath(databasePath);
      const payload = defaultPayload(databasePath);
      const actualConfig =
        await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
      let child: ReturnType<typeof spawn> | undefined;
      let closed: Promise<unknown> | undefined;
      let refusal: unknown;
      let releaseRequested = false;
      let held = false;
      let refusedReads = 0;
      const assertFresh = ownerRecord.assertPersistedStateDatabaseAccessAllowed;
      vi.spyOn(ownerRecord, "assertPersistedStateDatabaseAccessAllowed").mockImplementation(
        (...args) => {
          try {
            return assertFresh(...args);
          } catch (error) {
            refusal = error;
            refusedReads++;
            if (!expires && !releaseRequested && child?.connected) {
              releaseRequested = true;
              child.send(50);
            }
            throw error;
          }
        },
      );
      mocks.completePluginUpdate.mockImplementationOnce(async () => {
        child = spawn(
          process.execPath,
          [
            "--eval",
            `
        const fs = require('node:fs');
        const path = require('node:path');
        const ownerPath = process.argv[1];
        const payload = JSON.parse(process.argv[2]);
        process.on('message', message => {
          if (message === 'hold') {
            fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
            fs.writeFileSync(ownerPath, JSON.stringify({ ...payload, pid: process.pid, startTime: undefined }));
            process.send('held');
          } else {
            setTimeout(() => { fs.rmSync(ownerPath, { force: true }); process.disconnect(); }, message);
          }
        });
        process.send('ready');
      `,
            ownerPath,
            JSON.stringify(payload),
          ],
          { stdio: ["ignore", "ignore", "pipe", "ipc"] },
        );
        closed = once(child, "close");
        await once(child, "message");
        return { pluginUpdate: successfulPluginUpdate };
      });
      mocks.readConfig.mockImplementation(async () => {
        if (child?.connected && !held) {
          const holding = once(child, "message");
          child.send("hold");
          await holding;
          held = true;
        }
        return withOpenClawStateDatabaseReadSnapshot(
          () => actualConfig.readConfigFileSnapshot({ observe: false }),
          { env },
        );
      });
      vi.spyOn(service, "maybeRestartServiceAfterFailedMutableUpdate").mockResolvedValue(undefined);
      mocks.readServiceState.mockResolvedValue(managedServiceState(env));
      mocks.restartService.mockImplementation(async ({ onVerified }) => {
        await expect(fs.stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
        onVerified?.(Date.now());
        return "ok";
      });
      try {
        const work = finishSuccessfulPackageSwitch(
          { packageRoot: identity.home, restartEnvironment: env },
          {
            updateStepTimeoutMs: 300,
            result: { ...packageResult(), root: identity.home },
          },
          { candidateRuntime: true },
        );
        if (expires) {
          const failure = await work.catch((error: unknown) => error);
          expect(failure).toMatchObject({ result: { recovery: { serviceRestartSafe: true } } });
          const { result } = await resolveMutableUpdateFailure({
            cause: refusal,
            mode: "npm",
            root: identity.home,
            durationMs: 300,
            originalRecovery: async () => ({ ...healthyRecovery }),
          });
          expect(result.recovery).toEqual(healthyRecovery);
          const settled = await resolveSettledUpdateCommandResult(
            { opts: {}, root: identity.home, ownedManagedUpdateEnv: env },
            result,
            refusal,
          ).catch((error: unknown) => error);
          expect(settled).toMatchObject({ result: { recovery: { serviceRestartSafe: true } } });
          expect(mocks.restartService).not.toHaveBeenCalled();
        } else {
          await work;
          expect(refusedReads).toBeGreaterThanOrEqual(1);
          expect(mocks.restartService).toHaveBeenCalledOnce();
          expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({ status: "ok" });
        }
        expect(refusal).toBeInstanceOf(StateDatabaseOfflineMaintenanceError);
      } finally {
        if (child?.connected && !releaseRequested) {
          child.send(0);
        }
        await closed;
        identity.restore();
      }
    },
  );

  it.each([false, true])(
    "keeps actual data-at-risk refusal authoritative (dataAtRisk=%s)",
    async (dataAtRisk) => {
      const contention = new StateDatabaseOfflineMaintenanceError(
        "/synthetic/state.sqlite",
        "maintenance busy",
      );
      const error = dataAtRisk
        ? new AggregateError([
            contention,
            new DoctorMaintenanceRefusalError("incomplete migration", {
              kind: "data-at-risk",
              reason: "incomplete-migration",
            }),
          ])
        : new Error("settlement failed", { cause: contention });
      const original = packageResult();
      const postUpdate = createPostUpdateExceptionResult(
        { result: original, root: "/synthetic", startedAt: Date.now() },
        error,
      ).result;
      const originalRecovery = vi.fn(async () => ({ ...healthyRecovery }));
      const { result: fallback } = await resolveMutableUpdateFailure({
        ...original,
        root: "/synthetic",
        cause: error,
        originalRecovery,
      });
      expect(postUpdate.recovery?.serviceRestartSafe).toBe(!dataAtRisk);
      if (dataAtRisk) {
        expect(fallback.recovery?.serviceRestartSafe).not.toBe(true);
        expect(originalRecovery).not.toHaveBeenCalled();
      } else {
        expect(fallback.recovery).toEqual(healthyRecovery);
        expect(originalRecovery).toHaveBeenCalledOnce();
      }
    },
  );
}
