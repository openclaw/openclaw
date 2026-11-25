import fsSync from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { readConfigFileSnapshot as ReadConfigFileSnapshot } from "../../config/config.js";
import type { runUpdateFailureTriage as RunUpdateFailureTriage } from "../../infra/update-triage.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { TempHomeEnv } from "../../test-utils/temp-home.js";
import type { updateFinalizeCommand as UpdateFinalizeCommand } from "./update-command-finalize.js";
import type { updateCommand as UpdateCommand } from "./update-command.js";

export function registerFailureSelectorTests(deps: {
  updateCommand: typeof UpdateCommand;
  updateFinalizeCommand: typeof UpdateFinalizeCommand;
  updateGitRelease: typeof import("../../infra/update-runner-git-release.js").updateGitRelease;
  readConfigFileSnapshot: typeof ReadConfigFileSnapshot;
  profileStateDir: () => string;
  runUpdateFailureTriage: typeof RunUpdateFailureTriage;
  expectSelectorTriageFailure: typeof import("../update-cli-invocation.test-support.js").expectSelectorTriageFailure;
}) {
  it.each([{ name: "repair", run: deps.updateFinalizeCommand }])(
    "$name pins relative installation selectors before failed-update triage",
    async ({ name, run }) => {
      const failure = new Error(name === "update" ? "Git update failed" : "Config snapshot failed");
      if (name === "update") {
        // Target selection reads config before an admitted update installs failure triage.
        vi.mocked(deps.updateGitRelease).mockRejectedValueOnce(failure);
      } else {
        vi.mocked(deps.readConfigFileSnapshot).mockRejectedValueOnce(failure);
      }
      const cwd = process.cwd();
      const selectors = {
        OPENCLAW_STATE_DIR: path.relative(cwd, deps.profileStateDir()),
        OPENCLAW_CONFIG_PATH: path.relative(cwd, path.join(deps.profileStateDir(), "custom.json")),
        OPENCLAW_WORKSPACE_DIR: "relative-workspace",
      };
      await withEnvAsync(selectors, async () => {
        const error = await run({ yes: true, json: true }).catch((caught: unknown) => caught);
        expect(deps.runUpdateFailureTriage).toHaveBeenCalledOnce();
        const triageCall = vi.mocked(deps.runUpdateFailureTriage).mock.calls[0]?.[0];
        if (name === "update") {
          deps.expectSelectorTriageFailure(error, triageCall?.failure, failure, true);
        } else {
          expect(error).toBe(failure);
          expect(triageCall?.failure).toMatchObject({
            error: failure.message,
            result: {
              status: "error",
              reason: "update-failed",
              recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
              verification: {},
              failedStep: { failureFacts: [expect.objectContaining({ message: failure.message })] },
              steps: expect.arrayContaining([
                expect.objectContaining({
                  name: "gateway recovery verification",
                  exitCode: 1,
                  failureFacts: [expect.objectContaining({ code: "gateway-probe-failed" })],
                }),
              ]),
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
  const home = temporary?.home;
  if (!home) {
    return;
  }
  // Preserve a bounded fixture inventory before outer teardown removes it.
  try {
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
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (entries.length === 32) {
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
  } catch {
    // Diagnostics cannot replace the original cleanup failure.
  }
}
