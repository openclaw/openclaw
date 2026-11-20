// Codex Client Version Contract tests: ChatGPT subscription model discovery never
// lists as a Codex older than the one OpenClaw ships.
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const CODEX_PACKAGE_JSON_URL = new URL("../../extensions/codex/package.json", import.meta.url);
const OPENAI_CLIENT_VERSION_URL = new URL(
  "../../extensions/openai/codex-client-version.ts",
  import.meta.url,
);
// Read the bundled version literal without depending on its private binding name.
const BUNDLED_CODEX_VERSION_PATTERN = /^const [\w$]+ = "(\d+\.\d+\.\d+)";$/mu;

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
  const version = BUNDLED_CODEX_VERSION_PATTERN.exec(source)?.[1];
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
