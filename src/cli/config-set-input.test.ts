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
      name: "malformed expected JSON",
      options: { expectCurrentJson: "{enabled:true}" },
      message: "--expect-current-json must be valid JSON",
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

  it("parses valid --batch-json payloads", () => {
    const parsed = parseBatchSource({
      batchJson:
        '[{"path":"gateway.auth.mode","value":"token"},{"path":"channels.discord.token","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}},{"path":"secrets.providers.default","provider":{"source":"env"}}]',
    });
    expect(parsed).toEqual([
      {
        path: "gateway.auth.mode",
        value: "token",
      },
      {
        path: "channels.discord.token",
        ref: {
          source: "env",
          provider: "default",
          id: "DISCORD_BOT_TOKEN",
        },
      },
      {
        path: "secrets.providers.default",
        provider: {
          source: "env",
        },
      },
    ]);
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

  it.skipIf(process.platform === "win32").each(["--file", "--batch-file"] as const)(
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

  it.skipIf(process.platform === "win32").each(["--file", "--batch-file"] as const)(
    "reads a regular-file symlink passed as %s",
    (sourceLabel) => {
      const root = tempDirs.make("openclaw-config-input-symlink-");
      const inputPath = path.join(root, "input.json5");
      const linkPath = path.join(root, "input-link.json5");
      const contents = "{ name: '会议', enabled: true }";
      fs.writeFileSync(inputPath, contents, "utf8");
      fs.symlinkSync("input.json5", linkPath);
      expect(readConfigMutationFileSync(linkPath, sourceLabel)).toBe(contents);
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

  it("accepts --batch-file at exactly the size limit", () => {
    const content = '[{"path":"gateway.port","value":19000}]'.padEnd(8 * 1024 * 1024, " ");
    withBatchFile("openclaw-config-set-input-boundary-", content, (batchPath) => {
      const parsed = parseBatchSource({ batchFile: batchPath });
      expect(parsed).toEqual([{ path: "gateway.port", value: 19000 }]);
    });
  });

  it("rejects batch entries with non-finite numbers", () => {
    expect(() =>
      parseBatchSource({
        batchJson: '[{"path":"channels.custom.timeout","value":1e999}]',
      }),
    ).toThrow("Value must be a finite number");
  });
});
