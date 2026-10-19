import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fileLocks from "./file-lock.js";
import { writeUpdateRunReportArtifact } from "./update-failure-report-artifact.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function admittedReport() {
  const stateDir = tempDirs.make("update-report-authority-");
  const runId = "a4396fd1-6a2b-42fc-84d5-1c0abbdc3e5c";
  const outputPath = path.join(stateDir, "update-reports", `${runId}.md`);
  const revoked = new Error("Original update report authority was revoked");
  let current = true;
  return {
    stateDir,
    outputPath,
    revoked,
    revoke: () => {
      current = false;
    },
    params: {
      result: { ...updateResult("ok"), runId },
      report: { markdown: "Admitted update" },
      env: { OPENCLAW_STATE_DIR: stateDir },
      readRun: vi.fn(() => undefined),
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
      },
    },
  };
}

function updateResult(status: "ok" | "error"): UpdateRunResult {
  return {
    status,
    mode: "unknown",
    reason: status === "error" ? "update-refused" : undefined,
    steps:
      status === "error"
        ? [
            {
              name: "doctor",
              command: "openclaw doctor --lint",
              cwd: "/opt/openclaw",
              durationMs: 0,
              exitCode: 1,
              doctorLintFindings: [
                { checkId: "core/config", severity: "error", message: "Invalid configuration" },
              ],
            },
          ]
        : [],
    durationMs: 0,
  };
}

describe("update report artifact ownership", () => {
  it("rechecks original authority after waiting for the real report lock", async () => {
    const fixture = admittedReport();
    await fs.mkdir(path.dirname(fixture.outputPath), { recursive: true });
    const holder = await fileLocks.acquireFileLock(fixture.outputPath, {
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      stale: 30_000,
    });
    const waiting = createDeferred();
    const withFileLock = fileLocks.withFileLock;
    vi.spyOn(fileLocks, "withFileLock").mockImplementation((...args) => {
      const work = withFileLock(...args);
      waiting.resolve();
      return work;
    });
    const work = writeUpdateRunReportArtifact(fixture.params);
    const refused = expect(work).rejects.toBe(fixture.revoked);
    try {
      await waiting.promise;
      expect(fixture.params.readRun).not.toHaveBeenCalled();
      fixture.revoke();
    } finally {
      await holder.release();
    }
    await refused;
    expect(fixture.params.readRun).not.toHaveBeenCalled();
    expect(await fs.readdir(path.dirname(fixture.outputPath))).toEqual([]);
  });

  it("stops after a committed triage artifact when original authority is revoked", async () => {
    const fixture = admittedReport();
    const rename = fs.rename.bind(fs);
    let diagnostic: string | undefined;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      if (path.basename(String(args[1])).startsWith("openclaw-update-failure-")) {
        diagnostic = String(args[1]);
        fixture.revoke();
      }
    });
    await expect(
      writeUpdateRunReportArtifact({
        ...fixture.params,
        result: { ...updateResult("error"), runId: fixture.params.result.runId },
      }),
    ).rejects.toBe(fixture.revoked);
    expect(diagnostic).toBeDefined();
    expect(JSON.parse(await fs.readFile(diagnostic!, "utf8"))).toMatchObject({
      result: { status: "error" },
    });
    expect(fixture.params.readRun).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(path.dirname(fixture.outputPath))).toEqual([]);
    expect(
      (await fs.readdir(path.dirname(diagnostic!))).toSorted((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual([
      expect.stringMatching(/^openclaw-update-failure-.*\.json$/),
      expect.stringMatching(/^openclaw-update-lint-.*\.json$/),
    ]);
  });

  it("does not reread or refresh history after authority is revoked during unlock", async () => {
    const fixture = admittedReport();
    const withFileLock = fileLocks.withFileLock;
    let committed: string | undefined;
    vi.spyOn(fileLocks, "withFileLock").mockImplementation(async (...args) => {
      const value = await withFileLock(...args);
      committed = await fs.readFile(fixture.outputPath, "utf8");
      fixture.revoke();
      return value;
    });
    await expect(writeUpdateRunReportArtifact(fixture.params)).rejects.toBe(fixture.revoked);
    expect(fixture.params.readRun).toHaveBeenCalledTimes(1);
    expect(committed).toContain("Admitted update");
    expect(await fs.readFile(fixture.outputPath, "utf8")).toBe(committed);
    expect(await fs.readdir(path.dirname(fixture.outputPath))).toEqual([
      path.basename(fixture.outputPath),
    ]);
  });

  it("rechecks authority after staging without replacing the report or leaking its temp", async () => {
    const fixture = admittedReport();
    await fs.mkdir(path.dirname(fixture.outputPath), { recursive: true });
    await fs.writeFile(fixture.outputPath, "original report");
    const open = fs.open.bind(fs);
    let staged = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])).startsWith(".fs-safe-replace.")) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await sync();
          staged = true;
          fixture.revoke();
        });
      }
      return handle;
    });
    // A captured report does not take the missing-history preservation branch.
    await expect(
      writeUpdateRunReportArtifact({
        ...fixture.params,
        readRun: undefined,
      }),
    ).rejects.toBe(fixture.revoked);
    expect(staged).toBe(true);
    expect(await fs.readFile(fixture.outputPath, "utf8")).toBe("original report");
    expect(await fs.readdir(path.dirname(fixture.outputPath))).toEqual([
      path.basename(fixture.outputPath),
    ]);
  });

  it.each(["ok", "error"] as const)(
    "retains detached %s reports privately without changing shared temp or selected state",
    async (status) => {
      const root = tempDirs.make("update-report-artifact-");
      const sharedTemp = path.join(root, "shared-temp");
      const stateDir = path.join(root, "unadmitted-state");
      await fs.mkdir(sharedTemp);
      if (process.platform !== "win32") {
        await fs.chmod(sharedTemp, 0o1777);
      }
      const sentinel = path.join(sharedTemp, "unrelated.txt");
      await fs.writeFile(sentinel, "unrelated artifact");
      const parentBefore = await fs.stat(sharedTemp);
      const sentinelBefore = await fs.stat(sentinel);
      const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(sharedTemp);
      try {
        const reportPath = await writeUpdateRunReportArtifact({
          result: updateResult(status),
          report: { markdown: "Update report" },
          env: { OPENCLAW_STATE_DIR: stateDir },
          detached: true,
        });
        const reportDir = path.dirname(reportPath);
        expect(reportDir).not.toBe(sharedTemp);
        expect(path.dirname(reportDir)).toBe(sharedTemp);
        expect(await fs.readFile(reportPath, "utf8")).toContain("Update report");
        const entries = await fs.readdir(reportDir);
        expect(entries).toHaveLength(status === "error" ? 3 : 1);
        if (status === "error") {
          const diagnostic = entries.find((entry) => entry.startsWith("openclaw-update-failure-"))!;
          expect(
            JSON.parse(await fs.readFile(path.join(reportDir, diagnostic), "utf8")),
          ).toMatchObject({
            result: { status: "error" },
          });
          expect(await fs.readFile(reportPath, "utf8")).toContain(diagnostic);
          const inventory = entries.find((entry) => entry.startsWith("openclaw-update-lint-"))!;
          expect(
            JSON.parse(await fs.readFile(path.join(reportDir, inventory), "utf8")),
          ).toMatchObject({
            result: {
              steps: [
                expect.objectContaining({
                  doctorLintFindings: [expect.objectContaining({ checkId: "core/config" })],
                }),
              ],
            },
          });
        }
        expect(await fs.stat(sharedTemp)).toMatchObject({
          mode: parentBefore.mode,
          uid: parentBefore.uid,
          ino: parentBefore.ino,
        });
        expect(await fs.stat(sentinel)).toMatchObject({
          mode: sentinelBefore.mode,
          uid: sentinelBefore.uid,
          ino: sentinelBefore.ino,
        });
        expect(await fs.readFile(sentinel, "utf8")).toBe("unrelated artifact");
        if (process.platform !== "win32") {
          expect((await fs.stat(reportDir)).mode & 0o777).toBe(0o700);
          for (const entry of entries) {
            expect((await fs.stat(path.join(reportDir, entry))).mode & 0o777).toBe(0o600);
          }
        }
        await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        tmpdir.mockRestore();
      }
    },
  );

  it("keeps admitted reports in the selected state directory", async () => {
    const stateDir = tempDirs.make("update-report-admitted-");
    const runId = "a4396fd1-6a2b-42fc-84d5-1c0abbdc3e5c";
    const reportPath = await writeUpdateRunReportArtifact({
      result: { ...updateResult("ok"), runId },
      report: { markdown: "Admitted update" },
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(reportPath).toBe(path.join(stateDir, "update-reports", `${runId}.md`));
    expect(await fs.readFile(reportPath, "utf8")).toContain("Admitted update");
  });
});
