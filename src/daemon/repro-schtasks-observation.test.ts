import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getOwnedTaskProcessIds,
  readRelatedProcessDiagnostics,
} from "./schtasks.integration-observation.test-support.js";

const powershellPath = vi.hoisted(() => ({ getWindowsPowerShellExePath: vi.fn() }));

vi.mock("../infra/windows-install-roots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/windows-install-roots.js")>()),
  getWindowsPowerShellExePath: powershellPath.getWindowsPowerShellExePath,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function useFixedCimCensus(census: unknown[]): Promise<void> {
  const executable = path.join(tempDirs.make("openclaw-schtasks-census-"), "powershell-fixture");
  const output = JSON.stringify(census);
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    "utf8",
  );
  await fs.chmod(executable, 0o755);
  powershellPath.getWindowsPowerShellExePath.mockReturnValue(executable);
}

const contextParent = {
  ProcessId: 10,
  ParentProcessId: 1,
  CommandLine: "task scheduler host",
  CreationDate: "2026-10-28T12:00:00.0000000Z",
  UserModeTime: 100,
};
const taskRoot = {
  ProcessId: 20,
  ParentProcessId: 10,
  CommandLine: 'node "C:\\fixture\\probe.js"',
  CreationDate: "2026-10-28T12:00:01.0000000Z",
  UserModeTime: 200,
};
const processCensus = [
  contextParent,
  taskRoot,
  {
    ProcessId: 21,
    ParentProcessId: 20,
    CommandLine: "task supervisor",
    CreationDate: "2026-10-28T12:00:02.0000000Z",
  },
  {
    ProcessId: 22,
    ParentProcessId: 21,
    CommandLine: "gateway",
    CreationDate: "2026-10-28T12:00:03.0000000Z",
  },
  {
    ProcessId: 23,
    ParentProcessId: 22,
    CommandLine: "unmarked child",
    CreationDate: "2026-10-28T12:00:04.0000000Z",
  },
  {
    ProcessId: 24,
    ParentProcessId: 23,
    CommandLine: "unmarked grandchild",
    CreationDate: "2026-10-28T12:00:05.0000000Z",
  },
  {
    ProcessId: 30,
    ParentProcessId: 10,
    CommandLine: "unrelated sibling tree",
    CreationDate: "2026-10-28T12:00:06.0000000Z",
  },
  {
    ProcessId: 40,
    ParentProcessId: 2,
    CommandLine: "unrelated process",
    CreationDate: "2026-10-28T12:00:07.0000000Z",
  },
];

describe("Scheduled Task process diagnostics", () => {
  beforeEach(() => {
    powershellPath.getWindowsPowerShellExePath.mockReset();
  });

  it.skipIf(process.platform === "win32")(
    "keeps context parents diagnostic while owning the task root and every descendant",
    async () => {
      await useFixedCimCensus(processCensus);

      const capture = readRelatedProcessDiagnostics(["C:\\fixture\\probe.js"]);

      expect(capture.ok).toBe(true);
      expect(capture.truncated).toBe(false);
      expect(capture.processes.map((entry) => entry.ProcessId)).toEqual([10, 20, 21, 22, 23, 24]);
      expect(capture.processes[0]).toMatchObject(contextParent);
      const ownedProcesses = Reflect.get(capture, "ownedProcesses");
      expect(ownedProcesses?.map((entry: { ProcessId?: number }) => entry.ProcessId)).toEqual([
        20, 21, 22, 23, 24,
      ]);
      const ownedPids = getOwnedTaskProcessIds([20, 22, 50], capture);
      expect(ownedPids).toEqual([20, 22, 50, 21, 23, 24]);
      expect(ownedPids).not.toContain(contextParent.ProcessId);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps unrelated processes outside both diagnostic and owned sets",
    async () => {
      await useFixedCimCensus(processCensus);

      const capture = readRelatedProcessDiagnostics(["C:\\fixture\\not-a-task.js"]);

      expect(capture.ok).toBe(true);
      expect(capture.processes).toEqual([]);
      expect(Reflect.get(capture, "ownedProcesses")).toEqual([]);
      expect(getOwnedTaskProcessIds([], capture)).toEqual([]);
    },
  );
});
