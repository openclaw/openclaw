import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  parseBatchSource,
  parseConfigSetCurrentExpectation,
  readConfigMutationFileSync,
} from "./config-set-input.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeInput(contents: string | Buffer) {
  const file = path.join(tempDirs.make("openclaw-config-input-"), "mutation.json5");
  fs.writeFileSync(file, contents);
  return file;
}

describe("config set input parsing", () => {
  it("rejects malformed UTF-8 before parsing a mutation", () => {
    const file = writeInput(Buffer.from([0x22, 0xff, 0x22]));
    expect(() => readConfigMutationFileSync(file, "--file")).toThrow("--file must be valid UTF-8");
  });

  it("preserves valid Unicode, a literal replacement character and a BOM", () => {
    const contents = '\uFEFF[{path:"agents.entries.main.name",value:"中文 😀 \uFFFD"}]';
    const file = writeInput(contents);

    expect(readConfigMutationFileSync(file, "--batch-file")).toBe(contents);
    expect(parseBatchSource({ batchFile: file })).toEqual([
      { path: "agents.entries.main.name", value: "中文 😀 \uFFFD" },
    ]);
  });

  it("retains JSON null as an expectation rather than treating it as absent", () => {
    expect(parseConfigSetCurrentExpectation({ expectCurrentJson: "null" })).toEqual({
      kind: "json",
      value: null,
    });
  });

  it.each([
    [
      { expectCurrentAbsent: true, expectCurrentJson: "null" },
      "choose either --expect-current-absent or --expect-current-json",
    ],
    [{ expectCurrentJson: "1e999" }, "--expect-current-json must be valid JSON"],
    [{ expectCurrentAbsent: true, batchJson: "[]" }, "cannot be combined with batch mode"],
    [{ expectCurrentAbsent: true, dryRun: true }, "cannot be combined with --dry-run"],
  ] as const)("rejects current-value expectation %j", (options, message) => {
    expect(() => parseConfigSetCurrentExpectation(options)).toThrow(message);
  });

  it("rejects using both --batch-json and --batch-file", () => {
    expect(() => parseBatchSource({ batchJson: "[]", batchFile: "/tmp/batch.json" })).toThrow(
      "Use either --batch-json or --batch-file, not both.",
    );
  });

  it.each([
    ["[]", "--batch-json must contain at least one config update."],
    ['{"path":"p","value":"v"}', "--batch-json must be a JSON array."],
    ['[{"value":"v"}]', "--batch-json[0].path is required."],
    [
      '[{"path":"p","value":"v","provider":{"source":"env"}}]',
      "--batch-json[0] must include exactly one of: value, ref, provider.",
    ],
  ] as const)("rejects batch %s", (batchJson, message) => {
    expect(() => parseBatchSource({ batchJson })).toThrow(message);
  });

  it("rejects --batch-file when the file does not exist", () => {
    expect(() => parseBatchSource({ batchFile: "/nonexistent/path/batch.json5" })).toThrow(
      "--batch-file not found: /nonexistent/path/batch.json5",
    );
  });

  it("rejects a directory passed as --batch-file", () => {
    const batchPath = tempDirs.make("openclaw-config-set-directory-");
    expect(() => parseBatchSource({ batchFile: batchPath })).toThrow(
      `--batch-file must be a regular file: ${batchPath}. Choose a JSON5 input file and try again.`,
    );
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", () => {
    const fifoPath = path.join(tempDirs.make("openclaw-config-input-fifo-"), "input.pipe");
    execFileSync("mkfifo", [fifoPath]);
    const originalOpenSync = fs.openSync;
    using _ = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      // Fail instead of hanging the test if a regression opens this FIFO in blocking mode.
      if (
        file === fifoPath &&
        (typeof flags !== "number" || (flags & fs.constants.O_NONBLOCK) === 0)
      ) {
        throw new Error("Opening this FIFO would wait for a writer.");
      }
      return originalOpenSync(file, flags, mode);
    });

    expect(() => readConfigMutationFileSync(fifoPath, "--file")).toThrow(
      `--file must be a regular file: ${fifoPath}. Choose a JSON5 input file and try again.`,
    );
  });

  it("rejects --batch-file payloads above the config mutation limit", () => {
    const batchFile = writeInput(" ".repeat(8 * 1024 * 1024 + 1));
    expect(() => parseBatchSource({ batchFile })).toThrow(
      "--batch-file exceeds the 8 MiB supported maximum (8388608 bytes)",
    );
  });
});
