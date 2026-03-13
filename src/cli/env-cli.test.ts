import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We exercise the dotenv read/write helpers by re-exporting them for testing.
// The Command integration is covered by the option-collision tests pattern.

const mockConfigDir = path.join(os.tmpdir(), `openclaw-env-cli-test-${process.pid}`);

vi.mock("../utils.js", () => ({
  resolveConfigDir: () => mockConfigDir,
}));

describe("env-cli helpers", () => {
  beforeEach(() => {
    fs.mkdirSync(mockConfigDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(mockConfigDir, { recursive: true, force: true });
  });

  const envFile = () => path.join(mockConfigDir, ".env");

  // Re-import env-cli helpers after the mock is applied.
  async function helpers() {
    const mod = await import("./env-cli.js");
    // Access private helpers via the module's test-exported symbols.
    return mod.__test__;
  }

  it("parseDotEnv handles KEY=VALUE, quoted values, comments, and blank lines", async () => {
    const { parseDotEnv } = await helpers();
    const map = parseDotEnv(
      ["# comment", "", "FOO=bar", 'QUOTED="hello world"', "SINGLE='it works'", "EMPTY="].join(
        "\n",
      ),
    );
    expect(map.get("FOO")).toBe("bar");
    expect(map.get("QUOTED")).toBe("hello world");
    expect(map.get("SINGLE")).toBe("it works");
    expect(map.get("EMPTY")).toBe("");
    expect(map.has("# comment")).toBe(false);
  });

  it("serialiseDotEnv round-trips a map", async () => {
    const { parseDotEnv, serialiseDotEnv } = await helpers();
    const map = new Map([
      ["A", "simple"],
      ["B", "has spaces"],
      ["C", 'has "quotes"'],
    ]);
    const out = serialiseDotEnv(map);
    const roundTripped = parseDotEnv(out);
    expect(roundTripped.get("A")).toBe("simple");
    expect(roundTripped.get("B")).toBe("has spaces");
    expect(roundTripped.get("C")).toBe('has "quotes"');
  });

  it("readEnvFile returns empty map when file does not exist", async () => {
    const { readEnvFile } = await helpers();
    const map = readEnvFile();
    expect(map.size).toBe(0);
  });

  it("writeEnvFile + readEnvFile round-trip", async () => {
    const { readEnvFile, writeEnvFile } = await helpers();
    const map = new Map([
      ["ANTHROPIC_BASE_URL", "http://proxy.example.com"],
      ["ANTHROPIC_AUTH_TOKEN", "sk-test-123"],
    ]);
    writeEnvFile(map);
    expect(fs.existsSync(envFile())).toBe(true);
    const back = readEnvFile();
    expect(back.get("ANTHROPIC_BASE_URL")).toBe("http://proxy.example.com");
    expect(back.get("ANTHROPIC_AUTH_TOKEN")).toBe("sk-test-123");
  });

  it("writeEnvFile creates the config dir if it does not exist", async () => {
    const { writeEnvFile } = await helpers();
    fs.rmSync(mockConfigDir, { recursive: true, force: true });
    writeEnvFile(new Map([["KEY", "value"]]));
    expect(fs.existsSync(envFile())).toBe(true);
  });

  it.skipIf(process.platform === "win32")("writeEnvFile sets file mode 0o600", async () => {
    const { writeEnvFile } = await helpers();
    writeEnvFile(new Map([["SECRET", "hunter2"]]));
    const stat = fs.statSync(envFile());
    // 0o600 on the lower 9 permission bits.
    // Skipped on Windows: POSIX permission bits are not supported.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("env set assignment parsing: valid KEY=VALUE", async () => {
    const { parseAssignment } = await helpers();
    expect(parseAssignment("FOO=bar")).toEqual({ key: "FOO", value: "bar" });
    expect(parseAssignment("ANTHROPIC_BASE_URL=http://proxy:8080")).toEqual({
      key: "ANTHROPIC_BASE_URL",
      value: "http://proxy:8080",
    });
  });

  it("env set assignment parsing: value can contain = signs", async () => {
    const { parseAssignment } = await helpers();
    expect(parseAssignment("TOKEN=abc=def==")).toEqual({ key: "TOKEN", value: "abc=def==" });
  });

  it("env set assignment parsing: missing = returns null", async () => {
    const { parseAssignment } = await helpers();
    expect(parseAssignment("NOEQUALS")).toBeNull();
    expect(parseAssignment("")).toBeNull();
  });

  describe("redactValue", () => {
    it("passes through non-sensitive keys unchanged", async () => {
      const { redactValue } = await helpers();
      expect(redactValue("ANTHROPIC_BASE_URL", "http://proxy.example.com")).toBe(
        "http://proxy.example.com",
      );
    });

    it("redacts sensitive keys: shows first 4 chars then asterisks", async () => {
      const { redactValue } = await helpers();
      // "sk-abc123xyz" = 12 chars → first 4 "sk-a" + 8 asterisks
      expect(redactValue("ANTHROPIC_AUTH_TOKEN", "sk-abc123xyz")).toBe("sk-a********");
    });

    it("redacts short sensitive values fully (≤ 4 chars → all asterisks)", async () => {
      const { redactValue } = await helpers();
      expect(redactValue("MY_SECRET", "abc")).toBe("***");
      expect(redactValue("API_KEY", "abcd")).toBe("****");
    });
  });

  it.skipIf(process.platform === "win32")(
    "writeEnvFile enforces 0o600 even when file already exists with 0o644",
    async () => {
      const { writeEnvFile } = await helpers();
      // Create with broader permissions first (simulates manual setup).
      // Skipped on Windows: POSIX permission bits are not supported.
      fs.writeFileSync(envFile(), "EXISTING=1\n", { mode: 0o644 });
      expect(fs.statSync(envFile()).mode & 0o777).toBe(0o644);

      writeEnvFile(new Map([["EXISTING", "1"]]));
      expect(fs.statSync(envFile()).mode & 0o777).toBe(0o600);
    },
  );
});
