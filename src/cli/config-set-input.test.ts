import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  parseBatchSource,
  parseConfigSetCurrentExpectation,
  readConfigMutationFileSync,
  type ConfigSetCurrentExpectation,
  type ConfigSetOptions,
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

  it.each([
    [{ expectCurrentAbsent: true }, { kind: "absent" }],
    [{ expectCurrentJson: "null" }, { kind: "json", value: null }],
    [
      { expectCurrentJson: '{"enabled":true,"ports":[1,2]}' },
      { kind: "json", value: { enabled: true, ports: [1, 2] } },
    ],
  ] satisfies [ConfigSetOptions, ConfigSetCurrentExpectation][])(
    "parses current-value expectation %j",
    (options, expected) => {
      expect(parseConfigSetCurrentExpectation(options)).toEqual(expected);
    },
  );

  it.each([
    [
      "both expectation flags",
      { expectCurrentAbsent: true, expectCurrentJson: "null" },
      "choose either --expect-current-absent or --expect-current-json",
    ],
    [
      "non-finite expected number",
      { expectCurrentJson: "1e999" },
      "--expect-current-json must be valid JSON",
    ],
    [
      "batch mode",
      { expectCurrentAbsent: true, batchJson: "[]" },
      "cannot be combined with batch mode",
    ],
    ["dry-run", { expectCurrentAbsent: true, dryRun: true }, "cannot be combined with --dry-run"],
  ] as const)("rejects %s with a current-value expectation", (_name, options, message) => {
    expect(() => parseConfigSetCurrentExpectation(options)).toThrow(message);
  });

  it("rejects using both --batch-json and --batch-file", () => {
    expect(() => parseBatchSource({ batchJson: "[]", batchFile: "/tmp/batch.json" })).toThrow(
      "Use either --batch-json or --batch-file, not both.",
    );
  });

  it.each([
    ["malformed payload", "{", "Failed to parse --batch-json:"],
    ["empty batch payload", "[]", "--batch-json must contain at least one config update."],
    ["non-array payload", '{"path":"p","value":"v"}', "--batch-json must be a JSON array."],
    ["entry without path", '[{"value":"v"}]', "--batch-json[0].path is required."],
    [
      "entry with multiple mode keys",
      '[{"path":"p","value":"v","provider":{"source":"env"}}]',
      "--batch-json[0] must include exactly one of: value, ref, provider.",
    ],
  ] as const)("rejects %s", (_name, batchJson, message) => {
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

  it.skipIf(process.platform === "win32").each(["--file"] as const)(
    "rejects a FIFO passed as %s without waiting for a writer",
    (sourceLabel) => {
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

      expect(() => readConfigMutationFileSync(fifoPath, sourceLabel)).toThrow(
        `${sourceLabel} must be a regular file: ${fifoPath}. Choose a JSON5 input file and try again.`,
      );
    },
  );

  it("rejects --batch-file payloads above the config mutation limit", () => {
    const batchFile = writeInput(" ".repeat(8 * 1024 * 1024 + 1));
    expect(() => parseBatchSource({ batchFile })).toThrow(
      "--batch-file exceeds the 8 MiB supported maximum (8388608 bytes)",
    );
  });
});
