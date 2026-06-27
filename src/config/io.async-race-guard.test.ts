import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { assertBaseSnapshotStillCurrent } from "./io.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";

describe("Config I/O Async Race-Guard", () => {
  const testConfigPath = path.join(os.tmpdir(), `openclaw-race-guard-test-${Date.now()}.json5`);
  const testContent = '{\n  gateway: { mode: "production" }\n}';

  // Helper to create a mock fs that simulates async delay
  const createMockFs = () => ({
    promises: {
      readFile: async (p: string, _encoding: string) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
        return fs.readFileSync(p, "utf-8");
      },
    },
  });

  it("should pass when the file has not been mutated", async () => {
    fs.writeFileSync(testConfigPath, testContent);

    // The function calculates hash internally. For a real test, we'd need the internal hash helper,
    // but since we are testing the logic, we can derive the expected hash.
    // In src/config/io.ts, hashConfigRaw uses sha256.
    const crypto = await import("node:crypto");
    const expectedHash = crypto.createHash("sha256").update(testContent).digest("hex");

    const snapshot = {
      path: testConfigPath,
      hash: expectedHash,
      exists: true,
    };

    await expect(
      assertBaseSnapshotStillCurrent(snapshot, testConfigPath, createMockFs()),
    ).resolves.not.toThrow();

    fs.unlinkSync(testConfigPath);
  });

  it("should throw ConfigMutationConflictError when the file is mutated concurrently", async () => {
    fs.writeFileSync(testConfigPath, testContent);

    const crypto = await import("node:crypto");
    const expectedHash = crypto.createHash("sha256").update(testContent).digest("hex");

    const snapshot = {
      path: testConfigPath,
      hash: expectedHash,
      exists: true,
    };

    // Concurrent mutation: change the file content before the async read completes
    // We can't easily time it perfectly with a simple mock,
    // so we'll just change it before calling the function.
    fs.writeFileSync(testConfigPath, '{\n  gateway: { mode: "debug" }\n}');

    await expect(
      assertBaseSnapshotStillCurrent(snapshot, testConfigPath, createMockFs()),
    ).rejects.toThrow(ConfigMutationConflictError);

    fs.unlinkSync(testConfigPath);
  });

  it("should throw conflict when file is deleted", async () => {
    fs.writeFileSync(testConfigPath, testContent);
    const crypto = await import("node:crypto");
    const expectedHash = crypto.createHash("sha256").update(testContent).digest("hex");

    const snapshot = {
      path: testConfigPath,
      hash: expectedHash,
      exists: true,
    };

    fs.unlinkSync(testConfigPath);

    await expect(
      assertBaseSnapshotStillCurrent(snapshot, testConfigPath, createMockFs()),
    ).rejects.toThrow(ConfigMutationConflictError);
  });
});
