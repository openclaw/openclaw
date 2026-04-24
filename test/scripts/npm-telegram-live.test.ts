import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { __testing } from "../../scripts/e2e/npm-telegram-live-runner.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");

describe("npm Telegram live Docker E2E", () => {
  it("supports npm-specific Convex credential aliases", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE");
    expect(script).toContain("OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE");
    expect(script).toContain('docker_env+=(-e OPENCLAW_QA_CREDENTIAL_SOURCE="$credential_source")');
    expect(script).toContain('docker_env+=(-e OPENCLAW_QA_CREDENTIAL_ROLE="$credential_role")');
  });

  it("defaults CI runs to Convex when broker credentials are present", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'if [ -n "${CI:-}" ] && [ -n "${OPENCLAW_QA_CONVEX_SITE_URL:-}" ]; then',
    );
    expect(script).toContain("OPENCLAW_QA_CONVEX_SECRET_CI");
    expect(script).toContain("OPENCLAW_QA_CONVEX_SECRET_MAINTAINER");
    expect(script).toContain('printf "convex"');
  });

  it("lets npm-specific credential aliases override shared QA env", () => {
    expect(
      __testing.resolveCredentialSource({
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE: "convex",
        OPENCLAW_QA_CREDENTIAL_SOURCE: "env",
      }),
    ).toBe("convex");
    expect(
      __testing.resolveCredentialRole({
        OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE: "ci",
        OPENCLAW_QA_CREDENTIAL_ROLE: "maintainer",
      }),
    ).toBe("ci");
  });
});
