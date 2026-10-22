import * as crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
afterEach(() => vi.mocked(crypto.randomUUID).mockReset());

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const lintFindings = () => [
  { checkId: "fixture/check", message: "Startup failed", severity: "error" },
];
const lintFailure = () => ({
  error: "Original Doctor failure",
  result: {
    status: "error" as const,
    mode: "npm" as const,
    steps: [{ name: "candidate doctor lint", exitCode: 1, doctorLintFindings: lintFindings() }],
  },
});

let stateDir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-update-triage-");
  env = { OPENCLAW_STATE_DIR: stateDir };
});
const readReleased = (file: string) => readReleasedTriageUpdateFailure(file, { env, stateDir });
const detachedPath = (segments = 1, repeats = 5) =>
  path.join(
    tempDirs.make("update-detached-"),
    ...Array.from({ length: segments }, () => "detached-diagnostics-".repeat(repeats)),
    "failure.json",
  );
const readBounded = async (file: string) => {
  const raw = await fs.readFile(file, "utf8");
  const released = await readReleased(file);
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8 * 1024);
  expect(Buffer.byteLength(JSON.stringify(released))).toBeLessThanOrEqual(4 * 1024);
  expect(Buffer.byteLength(JSON.stringify(released.error))).toBeLessThanOrEqual(768);
  return { raw, released };
};
const expectCopy = async (released: Awaited<ReturnType<typeof readReleased>>) => {
  const copiedPath = await writeTriageUpdateFailure(released, {
    env,
    outputPath: path.join(stateDir, "copy.json"),
  });
  expect((await readReleased(copiedPath)).error).toBe(released.error);
};
it.each([
  [0, 0],
  [40, 1],
  [40, 40],
  [40, 0],
])("links %i findings (%i errors) across rollback", async (findingCount, errorCount) => {
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
  const step: UpdateRunResult["steps"][number] = {
    name: "candidate doctor lint",
    command: "doctor --lint --json",
    cwd: stateDir,
    durationMs: 1,
    exitCode: 1,
    doctorLintFindings: findings,
    ...physical,
    advisory: advisoryOnly
      ? { kind: "recoverable-maintenance", message: "Policy advice" }
      : undefined,
  };
  const result: UpdateRunResult = {
    runId: "10000000-0000-4000-8000-000000000001",
    status: "error",
    mode: "npm",
    durationMs: 1,
    reason: advisoryOnly ? "post-update-plugins" : "doctor-failed",
    steps: [step],
  };
  const originalError =
    errorCount === 40
      ? `Initial activation failure account 987654321098 ${"diagnostic context ".repeat(100)}`
      : undefined;
  // A valid UUID with a numeric tail must remain a readable diagnostic link.
  vi.mocked(crypto.randomUUID).mockReturnValue("00000000-0000-4000-8000-123456789012");
  const outputPath = await writeTriageUpdateFailure(
    { result, error: originalError },
    {
      env,
      outputPath: errorCount === 40 ? detachedPath() : undefined,
    },
  );
  const { raw, released } = await readBounded(outputPath);
  for (const excluded of [secret, stateDir, "987654321098"]) {
    expect(raw).not.toContain(excluded);
  }
  if (!released.error) {
    throw new Error("The released reader lost the failure context and inventory link.");
  }
  expect(released.error).toContain(originalError ? "Initial activation failure" : result.reason!);
  const inventoryPath = released.error
    .split("Complete Doctor lint inventory: ")[1]!
    .split(" Doctor lint receipt: ")[0]!
    .replace("$OPENCLAW_STATE_DIR", stateDir);
  const inventoryRaw = await fs.readFile(inventoryPath, "utf8");
  const inventory = JSON.parse(inventoryRaw);
  expect(inventory.result.steps[0].doctorLintFindings).toMatchObject(
    findings.map(({ checkId, message }) => ({ checkId, message })),
  );
  expect(inventoryRaw).not.toContain(secret);
  expect(inventoryRaw).not.toContain("987654321098");
  const bounded = JSON.parse(raw);
  const receipt = JSON.parse(bounded.result.steps[0].stderrTail);
  const releasedReceiptText =
    released.error?.split(" Doctor lint receipt: ")[1] ??
    ("result" in released ? released.result.steps[0]?.stderrTail : undefined);
  expect(JSON.parse(releasedReceiptText ?? "null")).toEqual(receipt);
  if (findingCount > 0) {
    await expect(readReleased(inventoryPath)).rejects.toThrow("exceeds 8192 bytes");
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
      readReleased(path.resolve(path.dirname(reportPath), link!)),
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
  for (const wireStep of "result" in wire ? wire.result.steps : []) {
    for (const key of ["doctorLintFindings", "signal", "killed", "outputLimitExceeded"]) {
      expect(wireStep).not.toHaveProperty(key);
    }
  }
  await expectCopy(released);
  expect(await fs.readFile(inventoryPath, "utf8")).toBe(inventoryRaw);
  if (process.platform !== "win32") {
    expect((await fs.stat(inventoryPath)).mode & 0o777).toBe(0o600);
  }
});

it("keeps bounded diagnostics when the complete inventory locator cannot fit", async () => {
  const outputPath = detachedPath(3, 10);
  await writeTriageUpdateFailure(lintFailure(), { env, outputPath });
  const { released } = await readBounded(outputPath);
  expect(released.error).toContain("Original Doctor failure");
  expect(released.error).toContain(
    "Complete Doctor lint inventory unavailable: diagnostic link exceeds error limit.",
  );
  const receipt = JSON.parse(released.error!.split(" Doctor lint receipt: ")[1]!);
  expect(receipt).toMatchObject({
    exitCode: 1,
    counts: { error: 1, warning: 0, info: 0 },
    errors: [{ checkId: "fixture/check", message: "Startup failed" }],
  });
  const inventoryName = (await fs.readdir(path.dirname(outputPath))).find((name) =>
    name.startsWith("openclaw-update-lint-"),
  );
  expect(inventoryName).toBeDefined();
  const inventory = JSON.parse(
    await fs.readFile(path.join(path.dirname(outputPath), inventoryName!), "utf8"),
  );
  expect(inventory.result.steps[0].doctorLintFindings).toEqual(lintFindings());
  await expectCopy(released);
});

it("keeps the original bounded failure when the complete inventory cannot be written", async () => {
  const rename = fs.rename;
  let rejectedInventory = 0;
  const writeInventory = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (path.basename(String(to)).startsWith("openclaw-update-lint-")) {
      rejectedInventory += 1;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return rename(from, to);
  });
  try {
    const outputPath = await writeTriageUpdateFailure(lintFailure(), { env });
    const failure = await readTriageUpdateFailure(outputPath, { env, stateDir });
    expect(failure.error).toContain("Original Doctor failure");
    expect(failure.error).toContain("Complete Doctor lint inventory unavailable: ENOSPC");
    expect(failure.error).not.toContain("Complete Doctor lint inventory:");
    expect(Buffer.byteLength(await fs.readFile(outputPath))).toBeLessThanOrEqual(8 * 1024);
    expect(rejectedInventory).toBe(1);
    expect(await fs.readdir(path.dirname(outputPath))).toEqual([path.basename(outputPath)]);
  } finally {
    writeInventory.mockRestore();
  }
});
