import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBatchSource } from "./config-set-input.js";

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

  it("rejects malformed --batch-json payloads", () => {
    expect(() =>
      parseBatchSource({
        batchJson: "{",
      }),
    ).toThrow("Failed to parse --batch-json:");
  });

  it("rejects --batch-json payloads that are not arrays", () => {
    expect(() =>
      parseBatchSource({
        batchJson: '{"path":"gateway.auth.mode","value":"token"}',
      }),
    ).toThrow("--batch-json must be a JSON array.");
  });

  it("rejects batch entries without path", () => {
    expect(() =>
      parseBatchSource({
        batchJson: '[{"value":"token"}]',
      }),
    ).toThrow("--batch-json[0].path is required.");
  });

  it("rejects batch entries that do not contain exactly one mode key", () => {
    expect(() =>
      parseBatchSource({
        batchJson: '[{"path":"gateway.auth.mode","value":"token","provider":{"source":"env"}}]',
      }),
    ).toThrow("--batch-json[0] must include exactly one of: value, ref, provider.");
  });

  it("parses valid --batch-file payloads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-set-input-"));
    const batchPath = path.join(tempDir, "batch.json");
    fs.writeFileSync(batchPath, '[{"path":"gateway.auth.mode","value":"token"}]', "utf8");
    try {
      const parsed = parseBatchSource({
        batchFile: batchPath,
      });
      expect(parsed).toEqual([
        {
          path: "gateway.auth.mode",
          value: "token",
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed --batch-file payloads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-set-input-invalid-"));
    const batchPath = path.join(tempDir, "batch.json");
    fs.writeFileSync(batchPath, "{}", "utf8");
    try {
      expect(() =>
        parseBatchSource({
          batchFile: batchPath,
        }),
      ).toThrow("--batch-file must be a JSON array.");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
