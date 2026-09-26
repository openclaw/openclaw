import "./update-command-service-maintenance.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { withUpdateInProgressEnv } from "./update-command-service-env.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import { maybeRestartService } from "./update-command-service.js";

const { fixtureGatewayPid, mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

it.runIf(process.platform === "linux").each([
  { account: "user", uid: 2001, writable: true, update: true },
  { account: "root", uid: 0, writable: true, update: true },
  { account: "user", uid: 2001, writable: false, update: true },
  { account: "standalone Doctor", uid: 0, writable: true, update: false },
])(
  "preserves system-service ownership for $account (writable=$writable, update=$update)",
  ({ uid, writable, update }) =>
    withServiceHome(async (home) => {
      vi.spyOn(process, "getuid").mockReturnValue(uid);
      vi.spyOn(process, "geteuid").mockReturnValue(uid);
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
      const root = await fs.realpath(process.cwd());
      const unitName = "openclaw-production@worker.service";
      const restartCommand = `sudo systemctl restart ${unitName}`;
      const service = createMockGatewayService();
      mocks.service.mockReturnValue(service);
      vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: { HOME: home },
        command: {
          programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        },
        runtime: { status: "running", pid: fixtureGatewayPid, systemd: { managerUid: 0 } },
        systemdInstallation: {
          kind: "system",
          system: {
            scope: "system",
            unitName,
            unitPath: `/etc/systemd/system/${unitName}`,
          },
        },
      });
      if (!writable) {
        const access = fs.access;
        vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
          if (file === root && mode && (mode & fs.constants.W_OK) !== 0) {
            throw Object.assign(new Error("fixture install is read-only"), { code: "EACCES" });
          }
          await access(file, mode);
        });
      }
      const prepare = () =>
        maybeStopManagedServiceBeforeMutableUpdate({
          root,
          updateInstallKind: "package",
          shouldRestart: true,
          phase: "prepare",
          jsonMode: true,
        });
      const preparation = update ? withUpdateInProgressEnv(undefined, prepare) : prepare();
      if (!update) {
        expect(await preparation).toMatchObject({ stopped: true });
        expect(service.stop).toHaveBeenCalledOnce();
        return;
      }
      if (!writable) {
        const failure = await preparation.catch((error: unknown) => error);
        expect(failure).toMatchObject({
          reason: "managed-service-handoff-failed",
          message: expect.stringContaining(restartCommand),
        });
        expect(String(failure)).toContain(
          `${path.join(root, "openclaw.mjs")} update --yes --no-restart`,
        );
        expect(String(failure)).toContain(`sudo -u '#${(await fs.stat(root)).uid}' -- env `);
      } else {
        const prepared = await preparation;
        expect(prepared).toMatchObject({
          stopped: false,
          running: true,
          serviceMutationAllowed: false,
          serviceMutationSkipMessage: expect.stringContaining(restartCommand),
        });
        const result: UpdateRunResult = {
          status: "ok",
          mode: "npm",
          root,
          steps: [],
          durationMs: 0,
        };
        await expect(
          maybeRestartService({
            shouldRestart: false,
            refreshServiceEnv: false,
            serviceEnv: prepared.serviceEnv,
            serviceMutationSkipMessage: prepared.serviceMutationSkipMessage,
            result,
            opts: { json: true },
            gatewayPort: 18789,
            timeoutMs: 1000,
          }),
        ).resolves.toBe("ok");
        expect(classifyUpdateOutcome(result)).toBe("succeeded");
        expect(result.steps).toEqual([
          expect.objectContaining({
            exitCode: 0,
            advisory: {
              kind: "recoverable-maintenance",
              message: expect.stringContaining(restartCommand),
            },
          }),
        ]);
        const report = renderUpdateRunReport(updateRunReportInputFromResult(result));
        expect(report.markdown).toContain(restartCommand);
      }
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
      expect(mocks.prepareStop).not.toHaveBeenCalled();
      expect(mocks.drain).not.toHaveBeenCalled();
    }),
);
