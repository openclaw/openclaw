import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fileLocks from "./file-lock.js";
import { writeUpdateRunReportArtifact } from "./update-failure-report-artifact.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { createUpdateRunRecordFixture } from "./update-run-record.test-support.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function admittedReport() {
  const stateDir = tempDirs.make("update-report-authority-");
  const runId = "a4396fd1-6a2b-42fc-84d5-1c0abbdc3e5c";
  const outputPath = path.join(stateDir, "update-reports", `${runId}.md`);
  const revoked = new Error("Original update report authority was revoked");
  let current = true;
  const params = {
    report: { markdown: "Admitted update" },
    env: { OPENCLAW_STATE_DIR: stateDir },
    readRun: vi.fn(() => undefined),
    assertCurrent: () => {
      if (!current) {
        throw revoked;
      }
    },
  };
  return {
    outputPath,
    revoked,
    readRun: params.readRun,
    revoke: () => {
      current = false;
    },
    write: (status: "ok" | "error" = "ok", capture = true) =>
      writeUpdateRunReportArtifact({
        ...params,
        result: { ...updateResult(status), runId },
        readRun: capture ? params.readRun : undefined,
      }),
    read: () => fs.readFile(outputPath, "utf8"),
    entries: () => fs.readdir(path.dirname(outputPath)),
  };
}

function updateResult(status: "ok" | "error"): UpdateRunResult {
  const steps: UpdateRunResult["steps"] = [
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
  ];
  return {
    status,
    mode: "unknown",
    ...(status === "error" ? { reason: "update-refused" } : {}),
    steps: status === "ok" ? [] : steps,
    durationMs: 0,
  };
}

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(file, "utf8"));
async function fileIdentity(file: string) {
  const { mode, uid, ino } = await fs.stat(file);
  return { mode, uid, ino };
}

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
  const work = fixture.write();
  const refused = expect(work).rejects.toBe(fixture.revoked);
  try {
    await waiting.promise;
    expect(fixture.readRun).not.toHaveBeenCalled();
    fixture.revoke();
  } finally {
    await holder.release();
  }
  await refused;
  expect(fixture.readRun).not.toHaveBeenCalled();
  expect(await fixture.entries()).toEqual([]);
});

it.each(["triage", "unlock", "staging"] as const)(
  "stops at revoked authority after %s without leaking artifacts or refreshing history",
  async (checkpoint) => {
    const fixture = admittedReport();
    let diagnostic: string | undefined;
    let committed: string | undefined;
    let staged = false;
    if (checkpoint === "triage") {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (path.basename(String(args[1])).startsWith("openclaw-update-failure-")) {
          diagnostic = String(args[1]);
          fixture.revoke();
        }
      });
    } else if (checkpoint === "unlock") {
      const withFileLock = fileLocks.withFileLock;
      vi.spyOn(fileLocks, "withFileLock").mockImplementation(async (...args) => {
        const value = await withFileLock(...args);
        committed = await fixture.read();
        fixture.revoke();
        return value;
      });
    } else {
      await fs.mkdir(path.dirname(fixture.outputPath), { recursive: true });
      await fs.writeFile(fixture.outputPath, "original report");
      const open = fs.open.bind(fs);
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
    }
    // A captured report does not take the missing-history preservation branch.
    await expect(
      fixture.write(checkpoint === "triage" ? "error" : "ok", checkpoint !== "staging"),
    ).rejects.toBe(fixture.revoked);
    if (checkpoint === "triage") {
      expect(diagnostic).toBeDefined();
      expect(await readJson(diagnostic!)).toMatchObject({ result: { status: "error" } });
      expect(await fixture.entries()).toEqual([]);
      expect((await fs.readdir(path.dirname(diagnostic!))).toSorted()).toEqual([
        expect.stringMatching(/^openclaw-update-failure-.*\.json$/),
        expect.stringMatching(/^openclaw-update-lint-.*\.json$/),
      ]);
    } else {
      expect(checkpoint === "staging" ? staged : committed).toEqual(
        checkpoint === "staging" ? true : expect.stringContaining("Admitted update"),
      );
      expect(await fixture.read()).toBe(checkpoint === "staging" ? "original report" : committed);
      expect(await fixture.entries()).toEqual([path.basename(fixture.outputPath)]);
    }
    if (checkpoint !== "staging") {
      expect(fixture.readRun).toHaveBeenCalledTimes(1);
    }
  },
);

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
    const parentBefore = await fileIdentity(sharedTemp);
    const sentinelBefore = await fileIdentity(sentinel);
    vi.spyOn(os, "tmpdir").mockReturnValue(sharedTemp);
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
      expect(await readJson(path.join(reportDir, diagnostic))).toMatchObject({
        result: { status: "error" },
      });
      expect(await fs.readFile(reportPath, "utf8")).toContain(diagnostic);
      const inventory = entries.find((entry) => entry.startsWith("openclaw-update-lint-"))!;
      expect(await readJson(path.join(reportDir, inventory))).toMatchObject({
        result: {
          steps: [{ doctorLintFindings: [{ checkId: "core/config" }] }],
        },
      });
    }
    expect(await fileIdentity(sharedTemp)).toEqual(parentBefore);
    expect(await fileIdentity(sentinel)).toEqual(sentinelBefore);
    expect(await fs.readFile(sentinel, "utf8")).toBe("unrelated artifact");
    if (process.platform !== "win32") {
      expect((await fs.stat(reportDir)).mode & 0o777).toBe(0o700);
      for (const entry of entries) {
        expect((await fs.stat(path.join(reportDir, entry))).mode & 0o777).toBe(0o600);
      }
    }
    await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["history", "capture"] as const)(
  "saves the target and failed swap from %s after rollback",
  async (source) => {
    const stateDir = tempDirs.make("update-report-swap-");
    const result: UpdateRunResult = {
      runId: "a4396fd1-6a2b-42fc-84d5-1c0abbdc3e5c",
      status: "error",
      mode: "npm",
      reason: "global-install-failed",
      before: { version: "2026.9.4" },
      after: { version: "2026.9.4" },
      steps: [
        {
          name: "global install swap",
          command: "synthetic swap",
          cwd: stateDir,
          durationMs: 0,
          exitCode: 1,
          stderrTail: "Package rollback verification timed out",
        },
      ],
      durationMs: 0,
    };
    const run: UpdateRunRecord = createUpdateRunRecordFixture(result.runId!, {
      reason: result.reason!,
      target: { kind: "package", version: "2026.10.6", channel: "stable" },
      before: result.before!,
      after: result.after!,
      steps: result.steps.flatMap(updateRunStepsFromResultStep),
    });
    const reportPath = await writeUpdateRunReportArtifact({
      result,
      env: { OPENCLAW_STATE_DIR: stateDir },
      ...(source === "history" ? { readRun: () => run } : { record: run }),
      report: (record) => renderUpdateRunReport(updateRunReportInputFromResult(result, record)),
    });
    expect(reportPath).toBe(path.join(stateDir, "update-reports", `${result.runId}.md`));
    const markdown = await fs.readFile(reportPath, "utf8");
    expect(markdown).toContain("Update target: 2026.10.6");
    expect(markdown).toContain("Failed: global install swap");
    const support = path.join(stateDir, "logs", "support");
    const diagnostic = (await fs.readdir(support)).find((entry) =>
      entry.startsWith("openclaw-update-failure-"),
    )!;
    expect(await readJson(path.join(support, diagnostic))).toMatchObject({
      result: { target: { version: "2026.10.6" }, steps: [{ name: "global install swap" }] },
    });
  },
);
