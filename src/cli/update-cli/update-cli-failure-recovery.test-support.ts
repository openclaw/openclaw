import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import type { readConfigFileSnapshot as ReadConfigFileSnapshot } from "../../config/config.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { runUpdateFailureTriage as RunUpdateFailureTriage } from "../../infra/update-triage.js";
import type {
  defaultRuntime as DefaultRuntime,
  ExitError as ExitErrorType,
} from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { TempHomeEnv } from "../../test-utils/temp-home.js";
import { VERSION } from "../../version.js";
import type { updateCommand as UpdateCommand } from "./update-command.js";

export async function mockUnbuiltRecoveryFixture(): Promise<void> {
  // These fixtures must not inherit build identity from the checkout's generated dist.
  vi.spyOn(
    await import("../../infra/update-git-runtime.js"),
    "readBuiltGatewayBuildId",
  ).mockResolvedValue(null);
}

export const recoveryVerificationStep = (
  failureFacts?: UpdateRunResult["steps"][number]["failureFacts"],
  cwd = process.cwd(),
) => ({
  name: "gateway recovery verification",
  command: "gateway verification",
  cwd,
  durationMs: expect.any(Number),
  exitCode: failureFacts ? 1 : 0,
  ...(failureFacts ? { failureFacts } : {}),
});
export const recoveryVersionMismatch = {
  check: "versionMatch",
  code: "version-mismatch",
  message: `Expected Gateway version ${VERSION}; observed 1.0.0.`,
};
export function registerForegroundFailureRecoveryTests({
  setupUpdatedRootRefresh,
  spawn,
  updateCommand,
  defaultRuntime,
  ExitError,
  spawnCall,
  lastWriteJsonCall,
  updateNpmInstalledPlugins,
}: {
  setupUpdatedRootRefresh: () => { root: string };
  spawn: Mock;
  updateCommand: typeof UpdateCommand;
  defaultRuntime: typeof DefaultRuntime;
  ExitError: typeof ExitErrorType;
  spawnCall: () => [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }] | undefined;
  lastWriteJsonCall: () => unknown;
  updateNpmInstalledPlugins: Mock;
}) {
  it.each([
    { exitCode: 2, handoff: undefined, expectedExit: 1 },
    { exitCode: 2, handoff: "1", expectedExit: 79 },
    { exitCode: 78, handoff: "1", expectedExit: 79 },
    { exitCode: 79, handoff: "1", expectedExit: 79 },
    { exitCode: 80, handoff: "1", expectedExit: 79 },
  ])(
    "preserves foreground failure $exitCode without granting handoff $handoff authority",
    async ({ exitCode, handoff, expectedExit }) => {
      const { root } = setupUpdatedRootRefresh();
      spawn.mockImplementationOnce(() => {
        const child = new EventEmitter() as EventEmitter & {
          once: EventEmitter["once"];
        };
        queueMicrotask(() => {
          child.emit("exit", exitCode, null);
          child.emit("close", exitCode, null);
        });
        return child;
      });

      await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, async () => {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(
          new ExitError(expectedExit),
        );
      });

      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(spawnCall()?.[2]?.env?.OPENCLAW_UPDATE_RUN_HANDOFF).toBe(handoff);
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "post-core-update-failed",
        recovery: { serviceRestartSafe: false },
        verification: {
          runningVersion: VERSION,
          versionMatch: true,
          readyz: true,
          settled: true,
        },
        steps: [recoveryVerificationStep(undefined, root)],
      });
      expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    },
  );
}

export function registerFailureSelectorTests({
  updateCommand,
  updateFinalizeCommand,
  readConfigFileSnapshot,
  profileStateDir,
  runUpdateFailureTriage,
  expectSelectorTriageFailure,
}: {
  updateCommand: typeof UpdateCommand;
  updateFinalizeCommand: typeof UpdateCommand;
  readConfigFileSnapshot: typeof ReadConfigFileSnapshot;
  profileStateDir: () => string;
  runUpdateFailureTriage: typeof RunUpdateFailureTriage;
  expectSelectorTriageFailure: typeof import("../update-cli-invocation.test-support.js").expectSelectorTriageFailure;
}) {
  it.each([
    { name: "update", run: updateCommand },
    { name: "repair", run: updateFinalizeCommand },
  ])(
    "$name pins relative installation selectors before failed-update triage",
    async ({ name, run }) => {
      const failure = new Error("Config snapshot failed");
      vi.mocked(readConfigFileSnapshot).mockRejectedValueOnce(failure);
      const cwd = process.cwd();
      const selectors = {
        OPENCLAW_STATE_DIR: path.relative(cwd, profileStateDir()),
        OPENCLAW_CONFIG_PATH: path.relative(cwd, path.join(profileStateDir(), "custom.json")),
        OPENCLAW_WORKSPACE_DIR: "relative-workspace",
      };
      await withEnvAsync(selectors, async () => {
        const error = await run({ yes: true, json: true, restart: false }).catch(
          (caught: unknown) => caught,
        );
        expect(runUpdateFailureTriage).toHaveBeenCalledOnce();
        const triageCall = vi.mocked(runUpdateFailureTriage).mock.calls[0]?.[0];
        if (name === "update") {
          expectSelectorTriageFailure(error, triageCall?.failure, failure, true);
        } else {
          expect(error).toBe(failure);
          expect(triageCall?.failure).toEqual({
            error: failure.message,
            result: {
              status: "error",
              mode: "unknown",
              root: cwd,
              durationMs: expect.any(Number),
              recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
              rollbackOutcome: undefined,
              verification: {},
              steps: [
                recoveryVerificationStep([
                  {
                    check: "gateway-recovery",
                    code: "gateway-probe-failed",
                    message:
                      "service management skipped: non-default state dir or config path. Rerun with HOME set to the OS account home, without OPENCLAW_HOME, and with OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH either unset o",
                  },
                ]),
              ],
            },
          });
        }
        for (const [key, value] of Object.entries(selectors)) {
          expect(triageCall?.target.env[key], key).toBe(path.resolve(cwd, value));
          expect(process.env[key]).toBe(value);
        }
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
      });
    },
  );
}

export function reportUpdateCliHomeCleanupFailure(temporary: TempHomeEnv | undefined): void {
  // Preserve a bounded fixture inventory before outer teardown removes it.
  try {
    const home = temporary?.home;
    if (home) {
      const inspect = (name: string) => {
        try {
          const stat = fsSync.lstatSync(path.join(home, name));
          return {
            name,
            type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
            mode: (stat.mode & 0o7777).toString(8),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
          };
        } catch (readError) {
          return { name, error: String(readError) };
        }
      };
      const root = inspect(".");
      const entries: ReturnType<typeof inspect>[] = [];
      let truncated = false;
      if (root.type === "directory") {
        const directory = fsSync.opendirSync(home);
        try {
          for (let index = 0; index <= 32; index++) {
            const entry = directory.readSync();
            if (!entry) {
              break;
            }
            if (index === 32) {
              truncated = true;
              break;
            }
            entries.push(inspect(entry.name));
          }
        } finally {
          directory.closeSync();
        }
      }
      console.error("Update CLI HOME cleanup failed", {
        home,
        capturedAt: Date.now(),
        root,
        entries,
        truncated,
      });
    }
  } catch {
    // Diagnostics cannot replace the original cleanup failure.
  }
}
