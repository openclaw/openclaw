import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import {
  createRequestReceipt,
  createTelegramFailureDiagnostic,
  type TelegramFailureDiagnostic,
} from "../../scripts/mantis/request-proof.ts";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { identity } from "./mantis-telegram.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const evidence = { artifact_id: "789", artifact_name: "fixture", sha256: "e".repeat(64) };
const encode = (value: unknown) => ({
  "telegram-failure.json": Buffer.from(JSON.stringify(value)).toString("base64"),
});
function receipt(value: unknown, execution: "failed" | "completed" = "failed", reason?: string) {
  return createRequestReceipt(identity, execution, evidence, encode(value), reason);
}
const makeDiagnostic = (category = "scope_rejected") =>
  createTelegramFailureDiagnostic(identity, [{ sequence: 1, category }]);

it("binds diagnostics without certifying absent captures", () => {
  const facts = makeDiagnostic();
  for (const execution of ["failed", "completed"] as const) {
    expect(receipt(facts, execution)).toMatchObject({
      assertion_outcome: "inconclusive",
      observations: [],
      reason: expect.stringContaining("1:scope_rejected"),
    });
  }
  const authorityReason = "PR is no longer open at the exact same-repository candidate head.";
  for (const value of [facts, { ...facts, raw: "private payload" }]) {
    expect(receipt(value, "failed", authorityReason).reason).toBe(authorityReason);
  }
  for (const changed of [
    { ...facts, candidate_sha: "f".repeat(40) },
    { ...facts, raw: "private payload" },
  ]) {
    const result = receipt(changed);
    expect(result).toMatchObject({
      reason: expect.stringContaining("malformed"),
      assertion_outcome: "inconclusive",
    });
    expect(JSON.stringify(result)).not.toContain("private payload");
  }
  for (const entries of [
    [],
    [{ sequence: 2, category: "scope_rejected" }],
    [{ sequence: 1, category: "private payload" }],
    [{ sequence: 1, category: "scope_rejected", message: "private payload" }],
    Array.from({ length: 17 }, (_, i) => ({ sequence: i + 1, category: "scope_rejected" })),
  ]) {
    expect(() => createTelegramFailureDiagnostic(identity, entries)).toThrow();
  }
});

it("isolates diagnostic-only archives", async () => {
  const root = tempDirs.make("tg-diagnostic-");
  const facts = makeDiagnostic("upstream_failure");
  for (const variant of ["valid", "mixed", "extra", "oversized"]) {
    const zip = new JSZip();
    zip.file(
      "telegram-failure.json",
      variant === "oversized" ? "x".repeat(16385) : JSON.stringify(facts),
    );
    if (variant === "mixed") {
      zip.file("telegram-send.json", "{}");
    }
    if (variant === "extra") {
      zip.file("raw.log", "private payload");
    }
    const archive = path.join(root, `${variant}.zip`),
      output = path.join(root, `${variant}.json`);
    await writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
    const parser = "scripts/mantis/read-request-archive.py";
    const args = ["-I", "-S", parser, "telegram-evidence", archive, output];
    const run = () => execFileSync("python3", args, { stdio: "pipe" });
    if (variant === "valid") {
      run();
      const files = JSON.parse(await readFile(output, "utf8"));
      const result = createRequestReceipt(identity, "failed", evidence, files);
      expect(result.reason).toContain("upstream_failure");
    } else {
      expect(run).toThrow();
    }
  }
});

it.for([
  "scope_rejected",
  "malformed_request",
  "upstream_failure",
  "network_failure",
  "authority_unavailable",
] as const)(
  "records %s through the real ingress without raw error or request data",
  async (expected, { signal }) => {
    const root = tempDirs.make(`ingress-${"nested-".repeat(20)}`);
    const result = await runNodeScript(
      [path.resolve("test/scripts/fixtures/mantis-telegram-failure.mts"), expected],
      process.env,
      undefined,
      {
        cwd: root,
        signal,
        maxBuffer: 64 * 1024,
        requireProcessTreeExit: process.platform !== "win32",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observations: {
      statuses: number[];
      initialDiagnostics: TelegramFailureDiagnostic[];
      diagnostics: TelegramFailureDiagnostic[];
      retainedCount: number;
    } = JSON.parse(result.stdout);
    expect(observations.statuses).toEqual(Array<number>(21).fill(403));
    expect(observations.initialDiagnostics.some((entry) => entry.category === expected)).toBe(true);
    if (expected === "authority_unavailable") {
      expect(observations.initialDiagnostics).toEqual([
        { sequence: 1, category: "authority_unavailable" },
      ]);
    }
    const diagnostic = createTelegramFailureDiagnostic(identity, observations.diagnostics);
    expect(diagnostic.diagnostics).toHaveLength(16);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|token|secret/);
    expect(observations.retainedCount).toBe(16);
  },
);
