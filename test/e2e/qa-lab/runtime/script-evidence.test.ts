import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "../../../../extensions/qa-lab/test-api.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const tempRoots: string[] = [];
const writerDefaults = {
  logFileName: "producer.log",
  primaryModel: "mock-openai/gpt-5.6-luna",
  providerMode: "mock-openai" as const,
  target: {
    id: "script-evidence-test",
    title: "Script evidence test",
    sourcePath: "test/e2e/qa-lab/runtime/script-evidence.test.ts",
  },
};
const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(file, "utf8"));
const readEvidence = async (base: string) =>
  validateQaEvidenceSummaryJson(await readJson(path.join(base, "qa-evidence.json")));

async function makeWriter(
  params: Pick<
    Parameters<typeof createQaScriptEvidenceWriter>[0],
    "maxDetailsBytes" | "maxLogBytes"
  > = {},
) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-script-evidence-"));
  tempRoots.push(repoRoot);
  const artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "script");
  const writer = createQaScriptEvidenceWriter({
    ...writerDefaults,
    artifactBase,
    coverageBinding: "none",
    maxLogBytes: 64,
    repoRoot,
    ...params,
  });
  return {
    artifactBase,
    repoRoot,
    writer,
    write: (details?: string, status: QaScriptEvidenceStatus = "fail") =>
      writer.write({ details, status, durationMs: 1 }),
    log: () => fs.readFile(path.join(artifactBase, "producer.log"), "utf8"),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

it("writes evidence with normalized artifact paths", async () => {
  const { artifactBase, writer } = await makeWriter();
  const summaryPath = path.join(artifactBase, "nested", "summary.json");
  writer.appendLog("producer output\n");

  const evidence = await writer.write({
    artifacts: [{ kind: "summary", filePath: summaryPath }],
    details: "pass details",
    durationMs: 25,
    status: "pass",
  });

  expect(evidence.entries[0]).toMatchObject({
    coverage: [],
    execution: {
      artifacts: [
        { kind: "log", path: "producer.log", source: "script" },
        { kind: "summary", path: path.join("nested", "summary.json"), source: "script" },
      ],
    },
    result: { status: "pass", timing: { wallMs: 25 } },
  });
  expect(await readEvidence(artifactBase)).toEqual(evidence);
  expect(await readJson(path.join(artifactBase, "latest-run.json"))).toEqual({
    qaEvidence: "qa-evidence.json",
  });
});

it("rejects uncataloged targets unless coverage binding is disabled", () => {
  expect(() =>
    createQaScriptEvidenceWriter({
      ...writerDefaults,
      artifactBase: path.join(os.tmpdir(), "openclaw-script-evidence-unknown"),
      repoRoot: process.cwd(),
    }),
  ).toThrow("unknown qa scenario: script-evidence-test");
});

it("keeps UTF-8 logs and failure details within byte limits", async () => {
  const { writer, write, log } = await makeWriter({ maxDetailsBytes: 9, maxLogBytes: 9 });
  const diagnostic = `${"🙂".repeat(32)}done`;
  writer.appendLog(diagnostic);

  const evidence = await write(diagnostic);
  const reason = evidence.entries[0]?.result.failure?.reason ?? "";
  for (const text of [await log(), reason]) {
    expect(text).toContain("done");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(9);
  }
});

it("applies built-in and configured redaction before bounding logs and details", async () => {
  const { repoRoot, writer, write, log } = await makeWriter({
    maxDetailsBytes: 4096,
    maxLogBytes: 4096,
  });
  const configPath = path.join(repoRoot, "openclaw.json");
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ logging: { redactPatterns: ["/internal-\\d+/g"] } })}\n`,
    "utf8",
  );
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  writer.appendLog(`${"x".repeat(16_380)}inter`);
  writer.appendLog("nal-12345 should hide password=s");
  writer.appendLog("k-split-secret-1234567890");

  const evidence = await write("reason internal-67890 should hide");
  const output = await log();
  expect(output).toContain("*** should hide password=sk-spl…7890");
  expect(output).not.toContain("internal-12345");
  expect(evidence.entries[0]?.result.failure?.reason).toBe("reason *** should hide");
});

it("omits oversized raw logs instead of truncating before redaction", async () => {
  const secretTail = "private-secret-tail-1234567890";
  const { writer, write, log } = await makeWriter({ maxLogBytes: 128 });
  writer.appendLog(`password=${"x".repeat(40 * 1024)}${secretTail}`);

  await write();
  const output = await log();
  expect(output).toBe("QA evidence log omitted: safe redaction buffer exceeded.\n");
});

it.each(["..", "../outside.log"])(
  "rejects artifact path %s outside the producer output directory",
  async (filePath) => {
    const { writer } = await makeWriter();

    expect(() =>
      writer.build({ artifacts: [{ kind: "log", filePath }], durationMs: 1, status: "fail" }),
    ).toThrow("QA evidence artifact must be inside artifact base");
  },
);
