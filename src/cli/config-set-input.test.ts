// Config set input tests cover config value parsing from CLI input and files.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  parseBatchSource,
  parseConfigSetCurrentExpectation,
  readConfigMutationFileSync,
} from "./config-set-input.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function withBatchFile<T>(prefix: string, contents: string, run: (batchPath: string) => T): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const batchPath = path.join(tempDir, "batch.json");
  fs.writeFileSync(batchPath, contents, "utf8");
  try {
    return run(batchPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("config set input parsing", () => {
  it.each(["--file"] as const)(
    "rejects malformed UTF-8 in %s before parsing a mutation",
    (sourceLabel) => {
      const root = tempDirs.make("openclaw-config-invalid-utf8-");
      const file = path.join(root, "mutation.json5");
      fs.writeFileSync(file, Buffer.from([0x22, 0xff, 0x22]));

      expect(() => readConfigMutationFileSync(file, sourceLabel)).toThrow(
        `${sourceLabel} must be valid UTF-8`,
      );
    },
  );

  it("preserves valid Unicode, a literal replacement character and a BOM", () => {
    const root = tempDirs.make("openclaw-config-valid-utf8-");
    const file = path.join(root, "mutation.json5");
    const contents = '\uFEFF[{path:"agents.entries.main.name",value:"中文 😀 \uFFFD"}]';
    fs.writeFileSync(file, contents, "utf8");

    expect(readConfigMutationFileSync(file, "--batch-file")).toBe(contents);
    expect(parseBatchSource({ batchFile: file })).toEqual([
      { path: "agents.entries.main.name", value: "中文 😀 \uFFFD" },
    ]);
  });

  it("parses absent and strict JSON current-value expectations", () => {
    expect(parseConfigSetCurrentExpectation({ expectCurrentAbsent: true })).toEqual({
      kind: "absent",
    });
    expect(parseConfigSetCurrentExpectation({ expectCurrentJson: "null" })).toEqual({
      kind: "json",
      value: null,
    });
    expect(
      parseConfigSetCurrentExpectation({ expectCurrentJson: '{"enabled":true,"ports":[1,2]}' }),
    ).toEqual({
      kind: "json",
      value: { enabled: true, ports: [1, 2] },
    });
  });

  it.each([
    {
      name: "both expectation flags",
      options: { expectCurrentAbsent: true, expectCurrentJson: "null" },
      message: "choose either --expect-current-absent or --expect-current-json",
    },
    {
      name: "non-finite expected number",
      options: { expectCurrentJson: "1e999" },
      message: "--expect-current-json must be valid JSON",
    },
    {
      name: "batch mode",
      options: { expectCurrentAbsent: true, batchJson: "[]" },
      message: "cannot be combined with batch mode",
    },
    {
      name: "dry-run",
      options: { expectCurrentAbsent: true, dryRun: true },
      message: "cannot be combined with --dry-run",
    },
  ] as const)("rejects $name with a current-value expectation", ({ options, message }) => {
    expect(() => parseConfigSetCurrentExpectation(options)).toThrow(message);
  });

  it("rejects using both --batch-json and --batch-file", () => {
    expect(() =>
      parseBatchSource({
        batchJson: "[]",
        batchFile: "/tmp/batch.json",
      }),
    ).toThrow("Use either --batch-json or --batch-file, not both.");
  });

  it.each([
    { name: "malformed payload", batchJson: "{", message: "Failed to parse --batch-json:" },
    {
      name: "empty batch payload",
      batchJson: "[]",
      message: "--batch-json must contain at least one config update.",
    },
    {
      name: "non-array payload",
      batchJson: '{"path":"gateway.auth.mode","value":"token"}',
      message: "--batch-json must be a JSON array.",
    },
    {
      name: "entry without path",
      batchJson: '[{"value":"token"}]',
      message: "--batch-json[0].path is required.",
    },
    {
      name: "entry with multiple mode keys",
      batchJson: '[{"path":"gateway.auth.mode","value":"token","provider":{"source":"env"}}]',
      message: "--batch-json[0] must include exactly one of: value, ref, provider.",
    },
  ] as const)("rejects $name", ({ batchJson, message }) => {
    expect(() => parseBatchSource({ batchJson })).toThrow(message);
  });

  it("rejects --batch-file when the file does not exist", () => {
    expect(() =>
      parseBatchSource({
        batchFile: "/nonexistent/path/batch.json5",
      }),
    ).toThrow("--batch-file not found: /nonexistent/path/batch.json5");
  });

  it("rejects a directory passed as --batch-file", () => {
    const batchPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-set-directory-"));
    try {
      expect(() => parseBatchSource({ batchFile: batchPath })).toThrow(
        `--batch-file must be a regular file: ${batchPath}. Choose a JSON5 input file and try again.`,
      );
    } finally {
      fs.rmSync(batchPath, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32").each(["--file"] as const)(
    "rejects a FIFO passed as %s without waiting for a writer",
    (sourceLabel) => {
      const fifoPath = path.join(tempDirs.make("openclaw-config-input-fifo-"), "input.pipe");
      execFileSync("mkfifo", [fifoPath]);
      const originalOpenSync = fs.openSync;
      const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
        // Fail instead of hanging the test if a regression opens this FIFO in blocking mode.
        if (
          file === fifoPath &&
          (typeof flags !== "number" || (flags & fs.constants.O_NONBLOCK) === 0)
        ) {
          throw new Error("Opening this FIFO would wait for a writer.");
        }
        return originalOpenSync(file, flags, mode);
      });
      try {
        expect(() => readConfigMutationFileSync(fifoPath, sourceLabel)).toThrow(
          `${sourceLabel} must be a regular file: ${fifoPath}. Choose a JSON5 input file and try again.`,
        );
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  it("rejects --batch-file payloads above the config mutation limit", () => {
    withBatchFile(
      "openclaw-config-set-input-oversized-",
      " ".repeat(8 * 1024 * 1024 + 1),
      (batchPath) => {
        expect(() => parseBatchSource({ batchFile: batchPath })).toThrow(
          "--batch-file exceeds the 8 MiB supported maximum (8388608 bytes)",
        );
      },
    );
  });
});
