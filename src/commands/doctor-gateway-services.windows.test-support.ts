import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveTaskName } from "../daemon/schtasks-layout.js";
import { buildScheduledTaskXml } from "../daemon/schtasks-xml.js";
import { createWindowsStartupServiceFixture } from "../daemon/service-definition-startup.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  expectNoNoteContaining,
  expectNoteContaining,
  mocks,
  mockProcessPlatform,
} from "./doctor-gateway-services.native.test-support.js";

export function registerDoctorWindowsServiceTests(
  runRepair: (cfg: OpenClawConfig) => Promise<void>,
) {
  describe("Windows service registration inspection", () => {
    const dirs = useAutoCleanupTempDirTracker(afterEach);
    afterEach(() => vi.restoreAllMocks());

    async function fixture(extension: "cmd" | "vbs" = "cmd") {
      const f = await createWindowsStartupServiceFixture(
        dirs.make("doctor-windows-service-"),
        extension,
      );
      const { auditGatewayServiceConfig } = await vi.importActual<
        typeof import("../daemon/service-audit.js")
      >("../daemon/service-audit.js");
      mocks.readCommand.mockImplementation(f.readCommand);
      mocks.buildGatewayInstallPlan.mockResolvedValue(f.command);
      mocks.auditGatewayServiceConfig.mockImplementation(auditGatewayServiceConfig);
      return f;
    }

    function expectNoRepair() {
      expect(mocks.stage).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.writeConfig).not.toHaveBeenCalled();
    }

    it.each(["cmd", "vbs"] as const)(
      "audits the registered Startup %s launcher without querying Task XML or changing it",
      async (extension) => {
        const f = await fixture(extension);
        await withEnvAsync(f.env, () => runRepair({ gateway: {} }));
        expect(mocks.auditGatewayServiceConfig.mock.calls[0]?.[0]?.command).toMatchObject(
          f.command,
        );
        expectNoNoteContaining("inspection could not be completed", "Gateway service definition");
        expect(f.task).not.toHaveBeenCalled();
        expect(await f.registration()).toEqual(f.originalRegistration);
        expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
        expectNoRepair();
      },
    );

    it.each([
      { label: "stopped", state: 3, enabled: true },
      { label: "disabled", state: 1, enabled: false },
    ])(
      "keeps a $label Scheduled Task inspectable without starting it",
      async ({ state, enabled }) => {
        const f = await fixture();
        f.taskState.mockReturnValue({
          status: "found",
          state,
          enabled,
          taskPath: resolveTaskName(f.env),
          actions: [{ type: 0, path: f.virtualScript, arguments: "", workingDirectory: "" }],
        });
        const xml = buildScheduledTaskXml({
          taskDescription: "",
          taskUser: f.env.USERNAME!,
          launchPath: f.sourcePath,
        });
        f.task.mockResolvedValue({
          code: 0,
          stdout: enabled ? xml : xml.replace(/(<Settings>[\s\S]*?<Enabled>)true/u, "$1false"),
          stderr: "",
        });
        await withEnvAsync(f.env, () => runRepair({ gateway: {} }));
        const audited = mocks.auditGatewayServiceConfig.mock.calls[0]?.[0]?.command;
        expect(audited?.programArguments).toEqual(f.command.programArguments);
        expect(audited?.startupEntryPaths).toBeUndefined();
        expect(f.task).toHaveBeenCalledWith(
          ["/Query", "/TN", resolveTaskName(f.env), "/XML"],
          undefined,
        );
        expectNoNoteContaining("inspection could not be completed", "Gateway service definition");
        expect(await f.registration()).toEqual(f.originalRegistration);
        expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
        expectNoRepair();
      },
    );

    it.each(["access denied", "unknown registration"])(
      "reports %s inspection without planning or repairing from the command file",
      async (detail) => {
        const f = await fixture();
        f.taskState.mockReturnValue({
          status: "unknown",
          detail,
          diagnostic: { kind: "native", exitCode: 1 },
        });
        await withEnvAsync(f.env, () => runRepair({ gateway: {} }));
        expectNoteContaining("inspection could not be completed", "Gateway service definition");
        expect(mocks.buildGatewayInstallPlan).not.toHaveBeenCalled();
        expect(mocks.auditGatewayServiceConfig).not.toHaveBeenCalled();
        expect(f.task).not.toHaveBeenCalled();
        expect(await f.registration()).toEqual(f.originalRegistration);
        expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
        expectNoRepair();
      },
    );

    it("does not plan from a leftover command file when no Windows registration remains", async () => {
      const f = await fixture();
      await fs.unlink(f.launcherPath);
      await withEnvAsync(f.env, () => runRepair({ gateway: {} }));
      expect(mocks.auditGatewayServiceConfig.mock.calls[0]?.[0]?.command).toBeNull();
      expect(mocks.buildGatewayInstallPlan).not.toHaveBeenCalled();
      expectNoNoteContaining("inspection could not be completed", "Gateway service definition");
      expect(f.task).not.toHaveBeenCalled();
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expectNoRepair();
    });

    it.each(["linux", "darwin"] as const)(
      "preserves the %s command read for unloaded definitions",
      async (platform) => {
        mockProcessPlatform(platform);
        const command = {
          programArguments: ["/usr/bin/node", "/opt/openclaw/index.js", "gateway"],
          environment: {},
        };
        mocks.readCommand.mockResolvedValue(command);
        mocks.buildGatewayInstallPlan.mockResolvedValue(command);
        mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
        await runRepair({ gateway: {} });
        expect(mocks.readCommand.mock.calls).toEqual([[process.env]]);
        expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
          expect.objectContaining({ command }),
        );
        expectNoRepair();
      },
    );
  });
}
