import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installScheduledTask, stageScheduledTask } from "./schtasks-install.js";
import {
  buildTaskScript,
  encodeWindowsLauncherScript,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";

const native = vi.hoisted(() => ({
  exec: vi.fn<typeof import("./schtasks-exec.js").execSchtasks>(),
  run: vi.fn<typeof import("./schtasks-control.js").runScheduledTaskOrThrow>(),
}));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.exec }));
vi.mock("./schtasks-control.js", () => ({ runScheduledTaskOrThrow: native.run }));
vi.mock("./schtasks-runtime.js", () => ({
  isStartupEntryInstalled: async () => false,
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  native.exec.mockReset();
  native.run.mockReset();
});

async function fixture() {
  const root = temporary.make("openclaw-task-rollback-");
  const env = {
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
  };
  const scriptPath = resolveTaskScriptPath(env);
  const launcherPath = scriptPath.replace(/\.cmd$/u, ".vbs");
  const original = encodeWindowsLauncherScript({
    format: "cmd",
    content: buildTaskScript({
      programArguments: ["node", "/prefix-a/openclaw/dist/index.js", "gateway"],
    }),
  });
  await fs.writeFile(scriptPath, original);
  await fs.writeFile(launcherPath, "original hidden launcher");
  const args = {
    env,
    stdout: new PassThrough(),
    programArguments: ["node", "/prefix-b/openclaw/dist/index.js", "gateway"],
  };
  return { args, scriptPath, launcherPath, original };
}

it("leaves both original launchers intact when staging cannot capture the hidden launcher", async () => {
  const { args, scriptPath, launcherPath, original } = await fixture();
  await fs.unlink(launcherPath);
  await fs.mkdir(launcherPath);
  await expect(stageScheduledTask(args)).rejects.toThrow();
  expect(await fs.readFile(scriptPath)).toEqual(original);
  expect((await fs.stat(launcherPath)).isDirectory()).toBe(true);
});

it.each(["registration", "xml-upgrade", "run"])(
  "retains the prior definition when %s fails",
  async (failure) => {
    const runAttempted = failure === "run";
    const { args, scriptPath, launcherPath, original } = await fixture();
    const originalXml =
      "<Task><Settings><Enabled>false</Enabled></Settings><Actions><Exec><Command>original</Command></Exec></Actions></Task>";
    native.exec.mockImplementation(async (command) => {
      if (command[0] === "/Query") {
        return { code: 0, stdout: originalXml, stderr: "" };
      }
      if (command[0] === "/Create" && command.includes("/XML")) {
        const xml = await fs.readFile(command.at(-1)!);
        if (xml.subarray(2).toString("utf16le") === originalXml) {
          return { code: 0, stdout: "", stderr: "" };
        }
      }
      return runAttempted || (failure === "xml-upgrade" && command[0] === "/Change")
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 2, stdout: "", stderr: "registration rejected" };
    });
    native.run.mockRejectedValue(new Error("run completion unknown"));
    const warn = vi.fn();
    await expect(installScheduledTask({ ...args, warn })).rejects.toThrow(
      runAttempted ? "run completion unknown" : "registration rejected",
    );
    expect(await fs.readFile(`${scriptPath}.bak`)).toEqual(original);
    expect(await fs.readFile(`${launcherPath}.bak`, "utf8")).toBe("original hidden launcher");
    expect((await fs.readFile(`${scriptPath}.task.xml.bak`)).subarray(2).toString("utf16le")).toBe(
      originalXml,
    );
    if (runAttempted) {
      expect(await fs.readFile(scriptPath)).not.toEqual(original);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("queued task may still start"));
    } else {
      expect(await fs.readFile(scriptPath)).toEqual(original);
      expect(await fs.readFile(launcherPath, "utf8")).toBe("original hidden launcher");
      expect(native.run).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    }
  },
);
