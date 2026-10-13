import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as layout from "./schtasks-layout.js";
import { readScheduledTaskDefinitionMutationCapability } from "./service-audit-schtasks.js";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { createWindowsStartupServiceFixture } from "./service-definition-startup.test-support.js";
import {
  GatewayServiceDefinitionBackupReceiptSchema,
  publishServiceFile,
  readServiceFileState,
} from "./service-stage.js";

const native = vi.hoisted(() => ({
  readCommand: vi.fn<typeof import("./schtasks-layout.js").readScheduledTaskCommand>(),
}));
// mock-isolation: Exercise definition custody without loading native service dispatchers.
vi.mock("./service.js", () => ({
  resolveGatewayService: () => ({ readCommand: native.readCommand }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  native.readCommand.mockReset();
});

async function startupFixture(extension: "cmd" | "vbs" = "cmd") {
  const fixture = await createWindowsStartupServiceFixture(
    dirs.make("service-definition-startup-"),
    extension,
  );
  native.readCommand.mockImplementation(fixture.readCommand);
  vi.spyOn(layout, "readScheduledTaskCommand").mockImplementation(native.readCommand);
  return fixture;
}

it.each(["cmd", "vbs"] as const)(
  "admits known Startup %s registration without changing it or accessing Task XML",
  async (extension) => {
    const f = await startupFixture(extension);
    expect(await readScheduledTaskDefinitionMutationCapability(f.env)).toEqual({
      kind: "writable",
    });
    expect(await f.registration()).toEqual(f.originalRegistration);
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(f.task).not.toHaveBeenCalled();
  },
);

it.each([
  "custom command",
  "custom Startup launcher",
  "conflicting aliases",
  "edited launcher",
  "replaced launcher",
  "appearing Task",
] as const)("refuses Startup mutation capability after %s", async (change) => {
  const f = await startupFixture();
  if (change === "custom command") {
    await fs.appendFile(f.sourcePath, "\r\noperator-command\r\n");
  } else if (change === "custom Startup launcher") {
    await fs.appendFile(f.launcherPath, "\r\noperator-command\r\n");
  } else if (change === "conflicting aliases") {
    await fs.writeFile(
      f.aliasPath,
      layout.buildHiddenLauncherScript({ scriptPath: "C:/Other/gateway.cmd" }),
    );
  } else {
    const readCommand = native.readCommand.getMockImplementation()!;
    let reads = 0;
    native.readCommand.mockImplementation(async (...args) => {
      reads += 1;
      if (reads === 2 && change === "edited launcher") {
        await fs.appendFile(f.launcherPath, "\r\noperator-command\r\n");
      } else if (reads === 2 && change === "replaced launcher") {
        const replacement = `${f.launcherPath}.replacement`;
        await fs.writeFile(replacement, f.launcher);
        await fs.rename(replacement, f.launcherPath);
      }
      const observed = await readCommand(...args);
      if (reads === 3 && change === "appearing Task") {
        f.registerTask();
      }
      return observed;
    });
  }
  expect(await readScheduledTaskDefinitionMutationCapability(f.env)).toEqual({
    kind: "unknown",
    reason: "inspection-failed",
  });
  expect(f.task).not.toHaveBeenCalled();
});

it.each(["compensation", "serialized receipt"] as const)(
  "restores changed command files through %s while retaining Startup registration",
  async (recovery) => {
    const f = await startupFixture("vbs");
    const capture = await f.capture();
    const candidate = Buffer.from(
      layout.buildTaskScript({
        ...f.command,
        programArguments: ["C:\\Node B\\node.exe", "C:\\OpenClaw\\index.js", "gateway"],
      }),
    );
    await publishServiceFile({
      filePath: f.sourcePath,
      contents: candidate,
      mode: 0o600,
      definitionTransaction: capture.hooks,
    });
    await publishServiceFile({
      filePath: f.companionPath,
      contents: layout.buildHiddenLauncherScript({ scriptPath: f.sourcePath }),
      mode: 0o600,
      definitionTransaction: capture.hooks,
    });
    const receipt = await capture.finish();
    expect(receipt.task).toBeUndefined();
    expect(receipt.guards).toEqual(
      expect.arrayContaining([
        { sourcePath: f.launcherPath, after: f.originalRegistration[0] },
        { sourcePath: f.aliasPath, after: null },
      ]),
    );
    expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
    expect(await readServiceFileState(f.companionPath)).not.toBeNull();
    expect(await f.registration()).toEqual(f.originalRegistration);
    if (recovery === "compensation") {
      expect(await capture.compensate()).toBe(true);
      const restored = await Promise.all([f.sourcePath, f.companionPath].map(readServiceFileState));
      await capture.compensate();
      expect(await Promise.all([f.sourcePath, f.companionPath].map(readServiceFileState))).toEqual(
        restored,
      );
    } else {
      const checkpoint = capture.backupPaths.find((file) => file.endsWith(".receipt.bak"))!;
      const retained = GatewayServiceDefinitionBackupReceiptSchema.parse(
        JSON.parse(await fs.readFile(checkpoint, "utf8")),
      );
      expect(retained).toEqual(receipt);
      await restoreGatewayServiceDefinitionBackup({
        env: f.env,
        command: f.command,
        assertCurrent: f.assertCurrent,
        receipt: retained,
      });
    }
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(await readServiceFileState(f.companionPath)).toBeNull();
    expect(await f.registration()).toEqual(f.originalRegistration);
    expect(f.task).not.toHaveBeenCalled();
  },
);

it.each(["appeared", "deleted", "edited", "replaced", "became a Task"] as const)(
  "preserves the current definition when Startup registration %s before publication",
  async (change) => {
    const f = await startupFixture();
    const capture = await f.capture();
    let changedRegistration = f.originalRegistration;
    await expect(
      publishServiceFile({
        filePath: f.sourcePath,
        contents: "candidate command\r\n",
        mode: 0o600,
        definitionTransaction: capture.hooks,
        beforeRename: async () => {
          if (change === "appeared") {
            await fs.writeFile(f.aliasPath, "operator launcher\r\n");
          } else if (change === "deleted") {
            await fs.unlink(f.launcherPath);
          } else if (change === "edited") {
            await fs.appendFile(f.launcherPath, "operator command\r\n");
          } else if (change === "replaced") {
            const replacement = `${f.launcherPath}.replacement`;
            await fs.writeFile(replacement, f.launcher);
            await fs.rename(replacement, f.launcherPath);
          } else {
            f.registerTask();
          }
          changedRegistration = await f.registration();
        },
      }),
    ).rejects.toThrow(
      /SERVICE_DEFINITION_UNKNOWN|Effective Scheduled Task service command could not be inspected/,
    );
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(await f.registration()).toEqual(changedRegistration);
    expect(f.task).not.toHaveBeenCalled();
  },
);
