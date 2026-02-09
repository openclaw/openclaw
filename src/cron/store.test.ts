import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { expandHomePrefix } from "../infra/home-dir.js";
import { resolveCronStorePath, DEFAULT_CRON_STORE_PATH } from "./store.js";

describe("resolveCronStorePath", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.CLAWDBOT_STATE_DIR;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should return explicit store path when provided", () => {
    const explicitPath = path.join("custom", "path", "jobs.json");
    const result = resolveCronStorePath(explicitPath);
    // Check that result ends with the expected path components
    expect(result).toContain(path.join("custom", "path", "jobs.json"));
    // Check it's an absolute path
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("should expand ~ in explicit store path", () => {
    const explicitPath = "~/custom/jobs.json";
    const result = resolveCronStorePath(explicitPath);
    const expandedHome = expandHomePrefix("~");
    // Should contain expanded home and the rest of the path
    expect(result).toContain(path.join(expandedHome, "custom", "jobs.json"));
  });

  it("should use OPENCLAW_STATE_DIR when set and no explicit path", () => {
    const stateDir = path.join("tmp", "openclaw-test");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const result = resolveCronStorePath();
    // Should end with cron/jobs.json
    expect(result).toContain(path.join("cron", "jobs.json"));
    // Should contain the state directory
    expect(result).toContain("openclaw-test");
  });

  it("should use CLAWDBOT_STATE_DIR as fallback", () => {
    const stateDir = path.join("tmp", "clawdbot-test");
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    const result = resolveCronStorePath();
    // Should end with cron/jobs.json
    expect(result).toContain(path.join("cron", "jobs.json"));
    // Should contain the state directory
    expect(result).toContain("clawdbot-test");
  });

  it("should expand ~ in OPENCLAW_STATE_DIR", () => {
    process.env.OPENCLAW_STATE_DIR = "~/openclaw-rescue";
    const result = resolveCronStorePath();
    const expandedHome = expandHomePrefix("~");
    // Should contain expanded home
    expect(result).toContain(expandedHome);
    // Should end with cron/jobs.json
    expect(result).toContain(path.join("cron", "jobs.json"));
  });

  it("should prefer OPENCLAW_STATE_DIR over CLAWDBOT_STATE_DIR", () => {
    process.env.OPENCLAW_STATE_DIR = path.join("tmp", "openclaw");
    process.env.CLAWDBOT_STATE_DIR = path.join("tmp", "clawdbot");
    const result = resolveCronStorePath();
    // Should use OPENCLAW_STATE_DIR (openclaw), not CLAWDBOT_STATE_DIR (clawdbot)
    expect(result).toContain("openclaw");
    expect(result).not.toContain("clawdbot");
  });

  it("should prefer explicit path over environment variables", () => {
    process.env.OPENCLAW_STATE_DIR = path.join("tmp", "from-env");
    const explicitPath = path.join("explicit", "custom", "jobs.json");
    const result = resolveCronStorePath(explicitPath);
    expect(result).toContain(path.join("explicit", "custom", "jobs.json"));
    // Should not contain the env var path (tmp/from-env)
    expect(result).not.toContain(path.join("tmp", "from-env"));
  });

  it("should return default path when no env vars and no explicit path", () => {
    const result = resolveCronStorePath();
    expect(result).toBe(DEFAULT_CRON_STORE_PATH);
  });

  it("should ignore empty/whitespace env vars", () => {
    process.env.OPENCLAW_STATE_DIR = "   ";
    const result = resolveCronStorePath();
    expect(result).toBe(DEFAULT_CRON_STORE_PATH);
  });

  it("should ignore empty/whitespace explicit path", () => {
    const result = resolveCronStorePath("   ");
    expect(result).toBe(DEFAULT_CRON_STORE_PATH);
  });
});
