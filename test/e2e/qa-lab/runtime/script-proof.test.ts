import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";
import { produceQaScriptProof } from "./script-proof.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  "agent-run-decision-receipt-summary.json",
  "autonomous-task-lifecycle-receipts-summary.json",
  "subagent-lineage-inspection-summary.json",
])("returns fresh successful evidence for %s", async (summaryFile) => {
  vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(125).mockReturnValue(99);
  const options = { artifactBase: "artifacts" };
  const runProof = vi.fn(async (received: typeof options) => {
    expect(received).toBe(options);
    return "proof passed";
  });
  const first = await produceQaScriptProof(options, runProof, summaryFile);
  expect(runProof).toHaveBeenCalledExactlyOnceWith(options);
  expect(first).toEqual({
    artifacts: [{ filePath: summaryFile, kind: "summary" }],
    details: "proof passed",
    durationMs: 25,
    status: "pass",
  });
  const second = await produceQaScriptProof(options, runProof, summaryFile);
  expect(runProof).toHaveBeenCalledTimes(2);
  expect(second.durationMs).toBe(1);
  expect(second).not.toBe(first);
  expect(second.artifacts).not.toBe(first.artifacts);
  expect(second.artifacts?.[0]).not.toBe(first.artifacts?.[0]);
});

it.each(["synchronous", "asynchronous"])(
  "formats %s failures before the terminal clock",
  async (mode) => {
    const events: string[] = [];
    vi.spyOn(Date, "now").mockImplementation(() => {
      events.push("clock");
      return 100;
    });
    const error = new Error("proof failed");
    Object.defineProperty(error, "message", {
      get() {
        events.push("format");
        return "proof failed";
      },
    });
    const runProof = vi.fn(() => {
      events.push("run");
      if (mode === "synchronous") {
        throw error;
      }
      return Promise.reject(error);
    });
    const result = await produceQaScriptProof({}, runProof, "summary.json");
    expect(runProof).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ details: "proof failed", durationMs: 1, status: "fail" });
    expect(Object.keys(result)).toEqual(["details", "durationMs", "status"]);
    expect(events.slice(0, 2)).toEqual(["clock", "run"]);
    expect(events.indexOf("format")).toBeGreaterThan(1);
    expect(events.lastIndexOf("format")).toBeLessThan(events.lastIndexOf("clock"));
  },
);

it.each([false, true])("waits for callback cleanup (rejects=%s)", async (rejects) => {
  const enteredCleanup = createDeferred();
  const releaseCleanup = createDeferred();
  let settled = false;
  const pending = produceQaScriptProof(
    {},
    async () => {
      try {
        return "proof passed";
      } finally {
        enteredCleanup.resolve();
        await releaseCleanup.promise;
      }
    },
    "summary.json",
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await awaitGateBeforeSettlement(
      enteredCleanup.promise,
      pending,
      "proof settled before cleanup",
    );
    expect(settled).toBe(false);
    if (rejects) {
      releaseCleanup.reject(new Error("cleanup failed"));
    } else {
      releaseCleanup.resolve();
    }
    const result = await pending;
    expect(result.status).toBe(rejects ? "fail" : "pass");
    expect(result.details).toBe(rejects ? "cleanup failed" : "proof passed");
    expect(result.artifacts).toEqual(
      rejects ? undefined : [{ filePath: "summary.json", kind: "summary" }],
    );
  } finally {
    releaseCleanup.resolve();
    await pending;
  }
});

it("leaves an initial clock failure outside the proof catch", async () => {
  const clock = vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("clock failed");
  });
  const runProof = vi.fn(async () => "unused");
  try {
    await expect(produceQaScriptProof({}, runProof, "summary.json")).rejects.toThrow(
      "clock failed",
    );
  } finally {
    clock.mockRestore();
  }
  expect(runProof).not.toHaveBeenCalled();
});

it.each(["pass", "fail"] as const)(
  "persists a %s result through the real evidence writer",
  async (status) => {
    const repoRoot = tempRoots.make("openclaw-script-proof-");
    const artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "script");
    const summaryFile = path.join(artifactBase, "nested", "summary.json");
    const writer = createQaScriptEvidenceWriter({
      artifactBase,
      repoRoot,
      coverageBinding: "none",
      logFileName: "producer.log",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      target: {
        id: "script-proof-test",
        title: "Script proof test",
        sourcePath: "test/e2e/qa-lab/runtime/script-proof.test.ts",
      },
    });
    const result = await produceQaScriptProof(
      {},
      async () => {
        if (status === "fail") {
          throw new Error("proof failed");
        }
        await fs.mkdir(path.dirname(summaryFile), { recursive: true });
        await fs.writeFile(summaryFile, "{}\n");
        return "proof passed";
      },
      summaryFile,
    );
    const log = `${result.status}: ${result.details}\n`;
    writer.appendLog(log);
    const evidence = await writer.write(result);
    expect(
      JSON.parse(await fs.readFile(path.join(artifactBase, "qa-evidence.json"), "utf8")),
    ).toEqual(evidence);
    expect(
      JSON.parse(await fs.readFile(path.join(artifactBase, "latest-run.json"), "utf8")),
    ).toEqual({ qaEvidence: "qa-evidence.json" });
    // A leading pass: field is redacted as a credential assignment by the writer.
    expect(await fs.readFile(path.join(artifactBase, "producer.log"), "utf8")).toBe(
      status === "pass" ? "pass: *** passed\n" : "fail: proof failed\n",
    );
    const entry = evidence.entries[0];
    expect(entry?.result.status).toBe(status);
    expect(entry?.result.failure?.reason).toBe(status === "fail" ? "proof failed" : undefined);
    expect(entry?.execution?.artifacts).toEqual([
      { kind: "log", path: "producer.log", source: "script" },
      ...(status === "pass"
        ? [{ kind: "summary", path: path.join("nested", "summary.json"), source: "script" }]
        : []),
    ]);
  },
);
