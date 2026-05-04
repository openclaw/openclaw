import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyConfigEnvVars } from "./config-env-vars.js";
import type { OpenClawConfig } from "./types.js";

describe("applyConfigEnvVars file: ref resolution", () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-env-file-ref-"));
    env = { OPENCLAW_STATE_DIR: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(vars: Record<string, string>): OpenClawConfig {
    return { env: { vars } } as unknown as OpenClawConfig;
  }

  it("resolves file: ref to file content", () => {
    const secretDir = path.join(tmpDir, "secrets");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "api-key.txt"), "sk-test-12345\n");

    applyConfigEnvVars(makeConfig({ MY_KEY: "file:secrets/api-key.txt" }), env);

    expect(env.MY_KEY).toBe("sk-test-12345");
  });

  it("trims trailing CRLF", () => {
    fs.writeFileSync(path.join(tmpDir, "key.txt"), "value123\r\n");

    applyConfigEnvVars(makeConfig({ K: "file:key.txt" }), env);

    expect(env.K).toBe("value123");
  });

  it("throws on missing file", () => {
    expect(() =>
      applyConfigEnvVars(makeConfig({ K: "file:nonexistent.txt" }), env),
    ).toThrow(/not found at/);
  });

  it("rejects path traversal outside state dir", () => {
    expect(() =>
      applyConfigEnvVars(makeConfig({ K: "file:../../../etc/passwd" }), env),
    ).toThrow(/resolves outside/);
  });

  it("does not override existing env var", () => {
    const secretDir = path.join(tmpDir, "secrets");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "k.txt"), "from-file");
    env.MY_KEY = "already-set";

    applyConfigEnvVars(makeConfig({ MY_KEY: "file:secrets/k.txt" }), env);

    expect(env.MY_KEY).toBe("already-set");
  });
});
