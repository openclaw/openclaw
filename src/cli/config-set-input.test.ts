// Config set input tests cover config value parsing from CLI input and files.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_FILE_BYTES, parseBatchSource } from "./config-set-input.js";

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
  it("returns null when no batch options are provided", () => {
    expect(parseBatchSource({})).toBeNull();
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

  it("parses valid --batch-file payloads", () => {
    withBatchFile(
      "openclaw-config-set-input-",
      '[{"path":"gateway.auth.mode","value":"token"}]',
      (batchPath) => {
        const parsed = parseBatchSource({
          batchFile: batchPath,
        });
        expect(parsed).toEqual([
          {
            path: "gateway.auth.mode",
            value: "token",
          },
        ]);
      },
    );
  });

  it("rejects malformed --batch-file payloads", () => {
    withBatchFile("openclaw-config-set-input-invalid-", "{}", (batchPath) => {
      expect(() =>
        parseBatchSource({
          batchFile: batchPath,
        }),
      ).toThrow("--batch-file must be a JSON array.");
    });
  });

  it("rejects oversized --batch-file payloads", () => {
    const largeContent = Buffer.alloc(MAX_BATCH_FILE_BYTES + 1, "x");
    withBatchFile("openclaw-config-set-input-large-", largeContent.toString(), (batchPath) => {
      expect(() => parseBatchSource({ batchFile: batchPath })).toThrow("Batch file too large");
    });
  });

  it("accepts --batch-file payload at the exact size limit", () => {
    // Build a valid entry at exactly MAX_BATCH_FILE_BYTES
    // Template: [{"path":"p","value":"PAD"}]
    // Prefix: 22 bytes, suffix: 3 bytes, so PAD = MAX - 25 = 1,048,551 bytes
    const padLen = MAX_BATCH_FILE_BYTES - 25;
    const content = `[{"path":"p","value":"${"x".repeat(padLen)}"}]`;
    expect(content.length).toBe(MAX_BATCH_FILE_BYTES);
    withBatchFile("openclaw-config-set-input-at-limit-", content, (batchPath) => {
      const parsed = parseBatchSource({ batchFile: batchPath });
      expect(parsed).toHaveLength(1);
      expect(parsed![0].path).toBe("p");
      expect(typeof parsed![0].value).toBe("string");
      expect((parsed![0].value as string).length).toBe(padLen);
    });
  });

  it("rejects zero-size batch files with parse error, not size error", () => {
    // A zero-size / empty file (stat.size === 0) should fail because it's
    // not valid JSON, not because of a size check.  Special files such as
    // /dev/zero present the same surface: stat appears small but read is
    // unbounded if not capped at the read call itself.
    withBatchFile("openclaw-config-set-input-empty-", "", (batchPath) => {
      expect(() => parseBatchSource({ batchFile: batchPath })).toThrow("Failed to parse");
    });
  });

  it("rejects FIFO (named pipe) --batch-file paths without blocking", () => {
    // POSIX-only: verify that O_NONBLOCK prevents the CLI from hanging when
    // a user supplies a FIFO path with no writer. Without O_NONBLOCK the
    // openSync call blocks indefinitely before fstat can check the file type.
    if (process.platform === "win32") return;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-set-input-fifo-"));
    try {
      const fifoPath = path.join(tempDir, "batch.fifo");
      execSync(`mkfifo "${fifoPath}"`);
      // Must throw (not hang).  The O_NONBLOCK open lets fstat identify the
      // FIFO, then the zero-byte read falls through to parseBatchEntries
      // which rejects the empty input.
      expect(() => parseBatchSource({ batchFile: fifoPath })).toThrow("Failed to parse");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 5_000);
});
