// Codex Client Version Contract tests: ChatGPT subscription model discovery never
// lists as a Codex older than the one OpenClaw ships.
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const CODEX_PACKAGE_JSON_URL = new URL("../../extensions/codex/package.json", import.meta.url);
const OPENAI_CLIENT_VERSION_URL = new URL(
  "../../extensions/openai/codex-client-version.ts",
  import.meta.url,
);
const OPENAI_CODEX_CLIENT_VERSION_FLOOR_PATTERN =
  /^const OPENAI_CODEX_CLIENT_VERSION_FLOOR = "([^"]+)";$/mu;

function readManagedCodexVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(CODEX_PACKAGE_JSON_URL, "utf8")) as {
    dependencies?: Record<string, unknown>;
  };
  const version = packageJson.dependencies?.["@openai/codex"];
  if (typeof version !== "string") {
    throw new Error("extensions/codex/package.json must pin @openai/codex exactly");
  }
  return version;
}

function readOpenAICodexClientVersionFloor(): string {
  const source = fs.readFileSync(OPENAI_CLIENT_VERSION_URL, "utf8");
  const version = OPENAI_CODEX_CLIENT_VERSION_FLOOR_PATTERN.exec(source)?.[1];
  if (!version) {
    throw new Error("extensions/openai/codex-client-version.ts must declare the Codex floor");
  }
  return version;
}

describe("Codex client version contract", () => {
  it("floors OpenAI subscription discovery at the managed Codex package", () => {
    expect(readOpenAICodexClientVersionFloor()).toBe(readManagedCodexVersion());
  });
});
