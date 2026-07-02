// Covers config include-file permission audit findings.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { collectIncludeFilePermFindings } from "./audit-extra.async.js";

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-include-perms-" });

async function makeTempDir(): Promise<string> {
  return suiteTempDirs.make("temp");
}

beforeAll(async () => {
  await suiteTempDirs.setup();
});

afterAll(async () => {
  await suiteTempDirs.cleanup();
});

describe("security audit config include permissions", () => {
  it("flags group/world-readable config include files", async () => {
    const tmp = await makeTempDir();
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const includePath = path.join(stateDir, "extra.json5");
    fs.writeFileSync(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    fs.chmodSync(includePath, 0o644);

    const configSnapshot: ConfigFileSnapshot = {
      path: path.join(stateDir, "openclaw.json"),
      exists: true,
      raw: `{ "$include": ${JSON.stringify(includePath)} }\n`,
      parsed: { $include: includePath },
      sourceConfig: {} as ConfigFileSnapshot["sourceConfig"],
      resolved: {} as ConfigFileSnapshot["resolved"],
      valid: true,
      runtimeConfig: {} as ConfigFileSnapshot["runtimeConfig"],
      config: {} as ConfigFileSnapshot["config"],
      issues: [],
      warnings: [],
      legacyIssues: [],
    };

    const findings = await collectIncludeFilePermFindings({
      configSnapshot,
      platform: "linux",
    });

    const finding = findings.find(
      (entry) => entry.checkId === "fs.config_include.perms_world_readable",
    );
    if (!finding) {
      throw new Error("Expected world-readable include finding");
    }
    expect(finding.severity).toBe("critical");
  });
});
