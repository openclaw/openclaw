import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as atomicFiles from "../infra/json-files.js";
import {
  writeTriageUpdateFailure,
  writeUpdateRunReportArtifact,
} from "../infra/update-failure-report-artifact.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import {
  readTriageUpdateFailure,
  sanitizeTriageUpdateFailure,
  updateFailureSchema,
} from "./triage-update.js";
import { readReleasedTriageUpdateFailure } from "./triage-update.released-reader.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
vi.mock("node:crypto", async () => ({
  ...(await vi.importActual<typeof import("node:crypto")>("node:crypto")),
  randomUUID: () => "10000000-0000-4000-8000-000000000001",
}));

describe("rollback-readable update diagnostics", () => {
  it.each([
    { findingCount: 0, errorCount: 0 },
    { findingCount: 40, errorCount: 1 },
    { findingCount: 40, errorCount: 40 },
    { findingCount: 40, errorCount: 0 },
  ])(
    "keeps $findingCount findings ($errorCount errors) linked from rollback-readable diagnostics",
    async ({ findingCount, errorCount }) => {
      const stateDir = tempDirs.make("openclaw-update-triage-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const secret = "sk-test-update-triage-secret-1234567890";
      const advisoryOnly = findingCount > 0 && errorCount === 0;
      const physical = {
        termination: advisoryOnly ? ("exit" as const) : ("signal" as const),
        signal: advisoryOnly ? null : ("SIGTERM" as const),
        killed: !advisoryOnly,
        outputLimitExceeded: !advisoryOnly,
      };
      const findings = Array.from({ length: findingCount }, (_, index) => ({
        checkId: `fixture/check-${index}`,
        severity: index < errorCount ? "error" : "warning",
        message:
          index === 0 && errorCount > 0 ? "Candidate startup failed" : `Optional advice ${index}`,
        fixHint: `${"Retained diagnostic context. ".repeat(16)} token=${secret}`,
      }));
      const result: UpdateRunResult = {
        runId: "10000000-0000-4000-8000-000000000001",
        status: "error",
        mode: "npm",
        reason: advisoryOnly ? "post-update-plugins" : "doctor-failed",
        ...(advisoryOnly
          ? {
              postUpdate: {
                plugins: {
                  status: "error" as const,
                  changed: false,
                  reason: "post-plugin-doctor-invalid-config",
                  sync: {
                    changed: false,
                    switchedToBundled: [],
                    switchedToNpm: [],
                    warnings: [],
                    errors: [],
                  },
                  npm: { changed: false, outcomes: [] },
                  integrityDrifts: [],
                },
              },
            }
          : {}),
        durationMs: 1,
        steps: [
          {
            name: "candidate doctor lint",
            command: "doctor --lint --json",
            cwd: stateDir,
            durationMs: 1,
            exitCode: 1,
            doctorLintFindings: findings,
            ...(advisoryOnly
              ? { advisory: { kind: "recoverable-maintenance" as const, message: "Policy advice" } }
              : {}),
            ...physical,
            failureFacts: advisoryOnly
              ? undefined
              : [
                  {
                    check: "fixture/check-0",
                    code: "doctor-failed",
                    message: "Candidate startup failed",
                  },
                ],
          },
        ],
      };
      const originalError =
        errorCount === 40
          ? `Initial activation failure account 987654321098 ${"diagnostic context ".repeat(100)}`
          : undefined;
      const outputPath = await writeTriageUpdateFailure(
        { result, error: originalError },
        {
          env,
          ...(errorCount === 40
            ? { outputPath: path.join(tempDirs.make("update-detached-"), "failure.json") }
            : {}),
        },
      );
      const raw = await fs.readFile(outputPath, "utf8");
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain(stateDir);
      expect(raw).not.toContain("987654321098");
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8 * 1024);
      const released = await readReleasedTriageUpdateFailure(outputPath, { env, stateDir });
      if (!released.error) {
        throw new Error("The released reader lost the failure context and inventory link.");
      }
      expect(Buffer.byteLength(JSON.stringify(released))).toBeLessThanOrEqual(4 * 1024);
      expect(Buffer.byteLength(JSON.stringify(released.error))).toBeLessThanOrEqual(768);
      expect(released.error).toContain(
        originalError ? "Initial activation failure" : result.reason!,
      );
      const inventoryPath = released.error
        .split("Complete Doctor lint inventory: ")[1]!
        .split(" Doctor lint receipt: ")[0]!
        .replace("$OPENCLAW_STATE_DIR", stateDir);
      const inventoryRaw = await fs.readFile(inventoryPath, "utf8");
      const inventory = JSON.parse(inventoryRaw);
      expect(inventory.result.steps[0].doctorLintFindings).toHaveLength(findingCount);
      expect(inventoryRaw).not.toContain(secret);
      expect(inventoryRaw).not.toContain("987654321098");
      for (const finding of findings) {
        expect(inventoryRaw).toContain(finding.checkId);
        expect(inventoryRaw).toContain(finding.message);
      }
      const bounded = JSON.parse(raw);
      const receipt = JSON.parse(bounded.result.steps[0].stderrTail);
      const releasedReceiptText =
        released.error?.split(" Doctor lint receipt: ")[1] ??
        ("result" in released ? released.result.steps[0]?.stderrTail : undefined);
      expect(JSON.parse(releasedReceiptText ?? "null")).toEqual(receipt);
      if (findingCount > 0) {
        await expect(
          readReleasedTriageUpdateFailure(inventoryPath, { env, stateDir }),
        ).rejects.toThrow("exceeds 8192 bytes");
      }
      expect(receipt).toMatchObject({
        ...physical,
        exitCode: 1,
        counts: { error: errorCount, warning: findingCount - errorCount, info: 0 },
      });
      expect(receipt.errors.length + receipt.omitted).toBe(errorCount);
      if (errorCount > 0) {
        expect(receipt.errors[0]).toEqual({
          checkId: "fixture/check-0",
          message: "Candidate startup failed",
        });
      }
      if (errorCount === 40) {
        expect(receipt.omitted).toBeGreaterThan(0);
        const reportPath = await writeUpdateRunReportArtifact({
          result,
          report: { markdown: "Synthetic update report" },
          env,
        });
        const markdown = await fs.readFile(reportPath, "utf8");
        const link = /^Bounded diagnostic JSON: ([^\r\n]+)$/mu.exec(markdown)?.[1];
        expect(link).toBeDefined();
        await expect(
          readReleasedTriageUpdateFailure(path.resolve(path.dirname(reportPath), link!), {
            env,
            stateDir,
          }),
        ).resolves.toMatchObject({
          error: expect.stringContaining("Complete Doctor lint inventory:"),
        });
      }
      expect(bounded.result.steps[0]).toMatchObject(physical);
      expect(bounded.result.steps[0]).not.toHaveProperty("doctorLintFindings");
      const artifact = await readTriageUpdateFailure(outputPath, { env, stateDir });
      const prompt = sanitizeTriageUpdateFailure(artifact, { env, stateDir });
      expect(Buffer.byteLength(JSON.stringify(prompt))).toBeLessThanOrEqual(4 * 1024);
      expect(prompt.error).toContain(path.basename(inventoryPath));
      const wire = updateFailureSchema.parse(artifact);
      for (const step of "result" in wire ? wire.result.steps : []) {
        for (const key of ["doctorLintFindings", "signal", "killed", "outputLimitExceeded"]) {
          expect(step).not.toHaveProperty(key);
        }
      }
      const copiedPath = await writeTriageUpdateFailure(released, {
        env,
        outputPath: path.join(stateDir, "copy.json"),
      });
      expect((await readReleasedTriageUpdateFailure(copiedPath, { env, stateDir })).error).toBe(
        released.error,
      );
      expect(await fs.readFile(inventoryPath, "utf8")).toBe(inventoryRaw);
      if (process.platform !== "win32") {
        expect((await fs.stat(inventoryPath)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("keeps the original bounded failure when the complete inventory cannot be written", async () => {
    const stateDir = tempDirs.make("openclaw-update-triage-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const writeTextAtomic = atomicFiles.writeTextAtomic;
    const writeInventory = vi
      .spyOn(atomicFiles, "writeTextAtomic")
      .mockImplementation((filePath, body, options) => {
        if (path.basename(filePath).startsWith("openclaw-update-lint-")) {
          return Promise.reject(new Error("ENOSPC: no space left on device"));
        }
        return writeTextAtomic(filePath, body, options);
      });
    try {
      const outputPath = await writeTriageUpdateFailure(
        {
          error: "Original Doctor failure",
          result: {
            status: "error",
            mode: "npm",
            steps: [
              {
                name: "candidate doctor lint",
                exitCode: 1,
                doctorLintFindings: [
                  { checkId: "fixture/check", message: "Startup failed", severity: "error" },
                ],
              },
            ],
          },
        },
        { env },
      );
      const failure = await readTriageUpdateFailure(outputPath, { env, stateDir });
      expect(failure.error).toContain("Original Doctor failure");
      expect(failure.error).toContain("Complete Doctor lint inventory unavailable: ENOSPC");
      expect(failure.error).not.toContain("Complete Doctor lint inventory:");
      expect(Buffer.byteLength(await fs.readFile(outputPath))).toBeLessThanOrEqual(8 * 1024);
    } finally {
      writeInventory.mockRestore();
    }
  });
});
