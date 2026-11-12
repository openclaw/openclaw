import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as directoryDurability from "../infra/directory-durability.js";
import {
  createMockTarStream,
  mockStateOnlyBackupPlan,
  backupWalkMock,
} from "./backup.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => {}));

vi.mock("../utils/sleep.js", () => ({
  sleep: (ms: number) => sleepMock(ms),
}));

// The fixture helper imports backup commands; install the tar mock before loading it.
const { isolatedBackupCase } = await import("../infra/backup-create.test-support.js");
const { backupCreateCommand } = await import("./backup.js");

describe("backupCreateCommand atomic archive write", () => {
  let home: string;
  let archiveDir: string;
  let outputPath: string;
  let runtime: ReturnType<typeof createTestRuntime>;

  function archiveCase(run: () => Promise<void>) {
    return isolatedBackupCase({
      layout: "home",
      scenario: "empty",
      prefix: "openclaw-backup-atomic-test-",
      env: { OPENCLAW_CONFIG_PATH: undefined },
    })(async (state) => {
      state.envVars.OPENCLAW_HOME = undefined;
      state.applyEnv();
      home = state.home;
      archiveDir = state.path("archives");
      outputPath = path.join(archiveDir, "backup.tar.gz");
      runtime = createTestRuntime();
      try {
        backupWalkMock.mockReset();
        sleepMock.mockClear();
        await fs.mkdir(archiveDir);
        await fs.writeFile(state.statePath("state.txt"), "state\n", "utf8");
        await mockStateOnlyBackupPlan(state.stateDir);
        await run();
      } finally {
        vi.restoreAllMocks();
      }
    });
  }

  it(
    "does not leave a partial final archive behind when tar creation fails",
    archiveCase(async () => {
      backupWalkMock.mockReturnValueOnce(createMockTarStream({ error: new Error("disk full") }));

      await expect(backupCreateCommand(runtime, { output: outputPath })).rejects.toThrow(
        /disk full/i,
      );

      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(archiveDir)).resolves.toStrictEqual([]);
    }),
  );

  it(
    "cleans intermediate retry archives after a later attempt succeeds",
    archiveCase(async () => {
      const volatilePath = path.join(home, ".openclaw", "logs", "gateway.log");
      await fs.mkdir(path.dirname(volatilePath), { recursive: true });
      await fs.writeFile(volatilePath, "volatile log\n", "utf8");
      const originalUnlinkSync = fsSync.unlinkSync.bind(fsSync);
      let blockedPartialPath: string | undefined;
      let blockedPartialCleanupAttempts = 0;
      vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
        const targetPath = path.resolve(String(target));
        if (!blockedPartialPath && targetPath.endsWith("archive.tar.gz.tmp")) {
          blockedPartialPath = targetPath;
        }
        if (targetPath === blockedPartialPath) {
          blockedPartialCleanupAttempts += 1;
          if (blockedPartialCleanupAttempts === 1) {
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          }
        }
        return originalUnlinkSync(target);
      });
      let tarAttempt = 0;
      backupWalkMock.mockImplementation((options: { skip: (entryPath: string) => boolean }) => {
        tarAttempt += 1;
        return createMockTarStream({
          beforeRead: () => {
            expect(options.skip(volatilePath)).toBe(true);
          },
          contents: `archive-attempt-${tarAttempt}`,
          ...(tarAttempt < 3
            ? {
                error: Object.assign(new Error("encountered unexpected EOF"), {
                  code: "EOF",
                  path: path.join(home, ".openclaw", "state.txt"),
                }),
              }
            : {}),
        });
      });

      const result = await backupCreateCommand(runtime, { output: outputPath });

      expect(result).toMatchObject({ archivePath: outputPath, skippedVolatileCount: 1 });
      expect(sleepMock.mock.calls).toStrictEqual([[10_000], [20_000]]);
      expect(blockedPartialCleanupAttempts).toBeGreaterThanOrEqual(2);
      expect((await fs.readdir(archiveDir)).toSorted()).toStrictEqual([path.basename(outputPath)]);
    }),
  );

  it(
    "does not overwrite an archive created after readiness checks complete",
    archiveCase(async () => {
      const publish = directoryDurability.publishFileExclusive;
      const publicationSpy = vi.spyOn(directoryDurability, "publishFileExclusive");
      backupWalkMock.mockReturnValueOnce(createMockTarStream());
      publicationSpy.mockImplementationOnce(async (options) => {
        await fs.writeFile(options.targetPath, "concurrent-archive", {
          encoding: "utf8",
          flag: "wx",
        });
        return await publish(options);
      });

      await expect(backupCreateCommand(runtime, { output: outputPath })).rejects.toThrow(
        /refusing to overwrite existing backup archive/i,
      );

      expect(await fs.readFile(outputPath, "utf8")).toBe("concurrent-archive");
    }),
  );
});
