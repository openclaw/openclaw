import * as childProcess from "node:child_process";
import { expect, it, vi } from "vitest";
import { probeScheduledTaskUpdateAccess } from "../../daemon/schtasks-state-probe.js";
import {
  expectNoSideEffects,
  getErrorOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
} from "../update-cli-assertions.test-support.js";
import type { createUpdateCliFixture } from "../update-cli-fixture.test-support.js";
import {
  serviceReadRuntime,
  serviceStop,
  suspendScheduledTaskAutoStartForUpdate,
} from "../update-cli-mocks.test-support.js";
import {
  ExitError,
  fetchNpmPackageTargetStatus,
  invokeUpdateCli,
} from "../update-cli-modules.test-support.js";

await vi.hoisted(() => import("../update-cli-mocks.test-support.js"));

export function registerWindowsTaskAdmissionTests(
  fixture: ReturnType<typeof createUpdateCliFixture>,
) {
  const callerSid = "S-1-5-21-111-222-333-1001";
  const ownTask = {
    callerSid,
    callerElevated: false,
    taskUserSid: callerSid,
    taskRunLevel: 0,
  };
  it.each([
    { scenario: "own per-user task", facts: ownTask, proceeds: true, tag: "2026.9.8" },
    {
      scenario: "another principal",
      facts: { ...ownTask, taskUserSid: "S-1-5-21-111-222-333-1002" },
      tag: "2026.9.8",
    },
    {
      scenario: "SYSTEM principal",
      facts: { ...ownTask, taskUserSid: "S-1-5-18" },
      tag: "2026.9.8",
    },
    { scenario: "highest privileges", facts: { ...ownTask, taskRunLevel: 1 }, tag: "2026.9.8" },
    { scenario: "access denied", tag: "2026.9.8" },
    { scenario: "timeout", tag: "2026.9.8" },
    { scenario: "access denied", tag: "openclaw@2026.9.8" },
  ])(
    "checks stopped Windows task admission from native facts: $scenario ($tag)",
    async ({ scenario, facts, proceeds, tag }) => {
      const nativeProbe = await vi.importActual<
        typeof import("../../daemon/schtasks-state-probe.js")
      >("../../daemon/schtasks-state-probe.js");
      vi.mocked(probeScheduledTaskUpdateAccess).mockImplementationOnce(
        nativeProbe.probeScheduledTaskUpdateAccess,
      );
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      await fixture.mockPackageInstallAtCaseDir();
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      const nativeSpawn = childProcess.spawnSync;
      let queriedScript = "";
      vi.spyOn(childProcess, "spawnSync").mockImplementation((command, args, options) => {
        if (!args?.includes("-EncodedCommand")) {
          return nativeSpawn(command, args, options);
        }
        queriedScript = Buffer.from(
          args[args.indexOf("-EncodedCommand") + 1] ?? "",
          "base64",
        ).toString("utf16le");
        const stdout = facts
          ? JSON.stringify(facts)
          : scenario === "access denied"
            ? "-2147024891"
            : "";
        return {
          pid: 0,
          output: [null, stdout, ""],
          stdout,
          stderr: "",
          status: facts ? 0 : scenario === "access denied" ? 2 : null,
          signal: null,
          ...(scenario === "timeout"
            ? {
                error: Object.assign(new Error("PowerShell did not complete"), {
                  code: "ETIMEDOUT",
                }),
              }
            : {}),
        };
      });

      if (proceeds) {
        await invokeUpdateCli({ tag, timeout: "2400", json: true });
        // The native adapter may report real HRESULTs, never invent one from token type.
        expect(queriedScript).not.toMatch(/Write-Output\s+['"]-2147024891['"]/);
        expect(queriedScript).toContain(".RunLevel");
        expect(queriedScript).toContain(".UserId");
        expect(lastWriteJsonCall(), getErrorOutput()).toMatchObject({ status: "ok" });
        expect(packageInstallCommandCall()).toBeDefined();
      } else {
        await expect(invokeUpdateCli({ tag, timeout: "2400", json: true })).rejects.toEqual(
          new ExitError(1),
        );
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "managed-service-preflight",
        });
        const output = getErrorOutput();
        expect(output).toContain("elevated terminal");
        expect(output).toContain("npm i -g openclaw@2026.9.8 --allow-scripts=openclaw");
        expect(output).toContain("openclaw doctor --fix");
        expect(output).toContain("openclaw gateway restart");
        if (scenario === "timeout") {
          expect(output).toContain("Task Scheduler task lookup/elevation check timed out");
          expect(output).toContain("60000 ms");
        }
        expectNoSideEffects(
          serviceStop,
          suspendScheduledTaskAutoStartForUpdate,
          fetchNpmPackageTargetStatus,
        );
        expect(packageInstallCommandCall()).toBeUndefined();
      }
      expect(
        vi
          .mocked(childProcess.spawnSync)
          .mock.calls.filter(([, args]) => args?.includes("-EncodedCommand")),
      ).toHaveLength(1);
      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["-EncodedCommand"]),
        expect.objectContaining({ timeout: 60_000 }),
      );
    },
  );
}
