import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "../../../../extensions/qa-lab/test-api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
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
type WriterOptions = Parameters<typeof createQaScriptEvidenceWriter>[0];

function makeWriter(
  params: Pick<WriterOptions, "maxDetailsBytes" | "maxLogBytes" | "coverageBinding"> = {},
) {
  const repoRoot = tempRoots.make("openclaw-script-evidence-");
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
    write: (details?: string) => writer.write({ details, status: "fail", durationMs: 1 }),
    log: () => fs.readFile(path.join(artifactBase, "producer.log"), "utf8"),
  };
}

afterEach(() => vi.unstubAllEnvs());

it("writes evidence with normalized artifact paths", async () => {
  const { artifactBase, writer } = makeWriter();
  const summaryPath = path.join(artifactBase, "nested", "summary.json");
  writer.appendLog("producer output\n");

  const evidence = await writer.write({
    artifacts: [{ kind: "summary", filePath: summaryPath }],
    details: "pass details",
    durationMs: 25,
    status: "pass",
  });

  expect(evidence.entries[0]?.coverage).toEqual([]);
  expect(evidence.entries[0]?.execution?.artifacts).toEqual([
    { kind: "log", path: "producer.log", source: "script" },
    { kind: "summary", path: path.join("nested", "summary.json"), source: "script" },
  ]);
  expect(
    validateQaEvidenceSummaryJson(await readJson(path.join(artifactBase, "qa-evidence.json"))),
  ).toEqual(evidence);
  expect(await readJson(path.join(artifactBase, "latest-run.json"))).toEqual({
    qaEvidence: "qa-evidence.json",
  });
});

it("rejects uncataloged targets unless coverage binding is disabled", () => {
  expect(() => makeWriter({ coverageBinding: "catalog" })).toThrow(
    "unknown qa scenario: script-evidence-test",
  );
});

it("keeps UTF-8 logs and failure details within byte limits", async () => {
  const { writer, write, log } = makeWriter({ maxDetailsBytes: 9, maxLogBytes: 9 });
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
  const { repoRoot, writer, write, log } = makeWriter({
    maxDetailsBytes: 4096,
    maxLogBytes: 4096,
  });
  const configPath = path.join(repoRoot, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ logging: { redactPatterns: ["/internal-\\d+/g"] } }),
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
  const { writer, write, log } = makeWriter({ maxLogBytes: 128 });
  writer.appendLog(`password=${"x".repeat(40 * 1024)}private-secret-tail-1234567890`);

  await write();
  expect(await log()).toBe("QA evidence log omitted: safe redaction buffer exceeded.\n");
});

it.each(["..", "../outside.log"])(
  "rejects artifact path %s outside the producer output directory",
  async (filePath) => {
    const { writer } = makeWriter();

    expect(() =>
      writer.build({ artifacts: [{ kind: "log", filePath }], durationMs: 1, status: "fail" }),
    ).toThrow("QA evidence artifact must be inside artifact base");
  },
);
