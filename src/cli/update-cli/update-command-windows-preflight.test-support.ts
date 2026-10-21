import * as childProcess from "node:child_process";
import { expect, it, vi } from "vitest";
import { probeScheduledTaskUpdateAccess } from "../../daemon/schtasks-state-probe.js";
import * as assertions from "../update-cli-assertions.test-support.js";
import type { createUpdateCliFixture } from "../update-cli-fixture.test-support.js";
import * as service from "../update-cli-mocks.test-support.js";
import * as api from "../update-cli-modules.test-support.js";

await vi.hoisted(() => import("../update-cli-mocks.test-support.js"));

export function registerWindowsTaskAdmissionTests(
  fixture: ReturnType<typeof createUpdateCliFixture>,
) {
  const callerSid = "S-1-5-21-111-222-333-1001";
  const ownTask = { callerSid, callerElevated: false, taskUserSid: callerSid, taskRunLevel: 0 };
  it.each(
    [
      { scenario: "own per-user task", facts: ownTask, proceeds: true },
      {
        scenario: "another principal",
        facts: { ...ownTask, taskUserSid: "S-1-5-21-111-222-333-1002" },
      },
      { scenario: "SYSTEM principal", facts: { ...ownTask, taskUserSid: "S-1-5-18" } },
      { scenario: "highest privileges", facts: { ...ownTask, taskRunLevel: 1 } },
      { scenario: "access denied" },
      { scenario: "timeout" },
      { scenario: "access denied", tag: "openclaw@2026.9.8" },
    ].map((row) => Object.assign({ tag: "2026.9.8" }, row)),
  )(
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
      service.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
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
        const denied = scenario === "access denied";
        const stdout = facts ? JSON.stringify(facts) : denied ? "-2147024891" : "";
        return {
          pid: 0,
          output: [null, stdout, ""],
          stdout,
          stderr: "",
          status: facts ? 0 : denied ? 2 : null,
          signal: null,
          error:
            scenario === "timeout"
              ? Object.assign(new Error("PowerShell did not complete"), { code: "ETIMEDOUT" })
              : undefined,
        };
      });

      const update = () => api.invokeUpdateCli({ tag, timeout: "2400", json: true });
      if (proceeds) {
        await update();
        // The native adapter may report real HRESULTs, never invent one from token type.
        expect(queriedScript).not.toMatch(/Write-Output\s+['"]-2147024891['"]/);
        expect(queriedScript).toContain(".RunLevel");
        expect(queriedScript).toContain(".UserId");
        expect(assertions.lastWriteJsonCall(), assertions.getErrorOutput()).toMatchObject({
          status: "ok",
        });
        expect(assertions.packageInstallCommandCall()).toBeDefined();
      } else {
        await expect(update()).rejects.toEqual(new api.ExitError(1));
        expect(assertions.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "managed-service-preflight",
        });
        const output = assertions.getErrorOutput();
        expect(output).toContain("elevated terminal");
        expect(output).toContain("npm i -g openclaw@2026.9.8 --allow-scripts=openclaw");
        expect(output).toContain("openclaw doctor --fix");
        expect(output).toContain("openclaw gateway restart");
        if (scenario === "timeout") {
          expect(output).toContain("Task Scheduler task lookup/elevation check timed out");
          expect(output).toContain("60000 ms");
        }
        assertions.expectNoSideEffects(
          service.serviceStop,
          service.suspendScheduledTaskAutoStartForUpdate,
          api.fetchNpmPackageTargetStatus,
        );
        expect(assertions.packageInstallCommandCall()).toBeUndefined();
      }
      const probes = vi
        .mocked(childProcess.spawnSync)
        .mock.calls.filter(([, args]) => args?.includes("-EncodedCommand"));
      expect(probes).toHaveLength(1);
      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["-EncodedCommand"]),
        expect.objectContaining({ timeout: 60_000 }),
      );
    },
  );
}
