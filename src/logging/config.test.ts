import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLoggingConfig } from "./config.js";

const originalArgv = process.argv;
const originalEnv = process.env.OPENCLAW_CONFIG_PATH;

describe("readLoggingConfig", () => {
  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalEnv;
    }
  });

  it("skips mutating config loads for config schema", async () => {
    process.argv = ["node", "openclaw", "config", "schema"];
    expect(readLoggingConfig()).toBeUndefined();
  });

  it("reads logging.file from the config path without loading the full config stack", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-logcfg-"));
    const configPath = path.join(dir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        logging: {
          file: "/tmp/openclaw-test/custom.log",
          level: "info",
        },
      }),
      "utf-8",
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.argv = ["node", "openclaw", "gateway"];

    const cfg = readLoggingConfig();
    expect(cfg?.file).toBe("/tmp/openclaw-test/custom.log");
    expect(cfg?.level).toBe("info");
  });
});
