// Covers state-directory dotenv discovery, parsing, and merge behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStateDirDotEnvFromStateDir } from "./state-dir-dotenv.js";
import { withTempHome, writeStateDirDotEnv } from "./test-helpers.js";

const FIXTURE = "REDACTED-FIXTURE";

describe("readStateDirDotEnvFromStateDir", () => {
  async function withDotEnv<T>(content: string, run: (dir: string) => T | Promise<T>): Promise<T> {
    return await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await writeStateDirDotEnv(content, { stateDir });
      return await run(stateDir);
    });
  }

  it("returns real credential values from the state-dir dotenv", async () => {
    await withDotEnv("SUPERMEMORY_API_KEY=sm_real_credential_value\n", async (dir) => {
      const result = readStateDirDotEnvFromStateDir(dir).entries;
      expect(result["SUPERMEMORY_API_KEY"]).toBe("sm_real_credential_value");
    });
  });

  it("retains operator-curated override-only keys placed in ~/.openclaw/.env", async () => {
    await withDotEnv(
      [
        `GH_TOKEN=${FIXTURE}-gh`,
        `GITHUB_TOKEN=${FIXTURE}-github`,
        `AWS_ACCESS_KEY_ID=${FIXTURE}-aws-akid`,
        `NPM_TOKEN=${FIXTURE}-npm`,
        `SSH_AUTH_SOCK=${FIXTURE}-ssh-sock`,
        `DATABASE_URL=${FIXTURE}-db-url`,
        "",
      ].join("\n"),
      (dir) => {
        const parsed = readStateDirDotEnvFromStateDir(dir).entries;

        expect(parsed.GH_TOKEN).toBe(`${FIXTURE}-gh`);
        expect(parsed.GITHUB_TOKEN).toBe(`${FIXTURE}-github`);
        expect(parsed.AWS_ACCESS_KEY_ID).toBe(`${FIXTURE}-aws-akid`);
        expect(parsed.NPM_TOKEN).toBe(`${FIXTURE}-npm`);
        expect(parsed.SSH_AUTH_SOCK).toBe(`${FIXTURE}-ssh-sock`);
        expect(parsed.DATABASE_URL).toBe(`${FIXTURE}-db-url`);
      },
    );
  });

  it("still strips truly everywhere-dangerous keys from ~/.openclaw/.env", async () => {
    await withDotEnv(
      [
        "LD_PRELOAD=/tmp/evil.so",
        "NODE_OPTIONS=--require /tmp/evil.js",
        "BASH_ENV=/tmp/evil.sh",
        "DYLD_LIBRARY_PATH=/tmp/evil-lib",
        "DYLD_INSERT_LIBRARIES=/tmp/evil-insert",
        "GIT_DIR=/tmp/evil-git",
        // Surviving sentinel proves the parser still ran.
        `SAFE_KEY=${FIXTURE}-safe`,
        "",
      ].join("\n"),
      (dir) => {
        const parsed = readStateDirDotEnvFromStateDir(dir).entries;

        expect(parsed.LD_PRELOAD).toBeUndefined();
        expect(parsed.NODE_OPTIONS).toBeUndefined();
        expect(parsed.BASH_ENV).toBeUndefined();
        expect(parsed.DYLD_LIBRARY_PATH).toBeUndefined();
        expect(parsed.DYLD_INSERT_LIBRARIES).toBeUndefined();
        expect(parsed.GIT_DIR).toBeUndefined();
        expect(parsed.SAFE_KEY).toBe(`${FIXTURE}-safe`);
      },
    );
  });

  it("skips empty values and ignores unknown safe keys", async () => {
    await withDotEnv(
      ["EMPTY_KEY=", "WHITESPACE_KEY=   ", `MY_CUSTOM_KEY=${FIXTURE}-custom`, ""].join("\n"),
      (dir) => {
        const parsed = readStateDirDotEnvFromStateDir(dir).entries;

        expect(parsed.EMPTY_KEY).toBeUndefined();
        expect(parsed.WHITESPACE_KEY).toBeUndefined();
        expect(parsed.MY_CUSTOM_KEY).toBe(`${FIXTURE}-custom`);
      },
    );
  });

  it("skips values that are unresolved shell variable references", async () => {
    const content = [
      'SUPERMEMORY_OPENCLAW_API_KEY="${SUPERMEMORY_OPENCLAW_KEY}"',
      "QUOTED_SUPERMEMORY_OPENCLAW_API_KEY='\"$SUPERMEMORY_OPENCLAW_KEY\"'",
      "QUOTED_CURLY_KEY=\"'${ANOTHER_VAR}'\"",
      "BRACE_DEFAULT_KEY=${ANOTHER_VAR:-fallback}",
      "QUOTED_BRACE_DEFAULT_KEY='\"${ANOTHER_VAR:-fallback}\"'",
      'BRACE_TRIM_KEY="${ANOTHER_VAR#prefix}"',
      "BRACE_REPLACE_KEY=${ANOTHER_VAR/pattern/replacement}",
      "BRACE_CASE_KEY=${ANOTHER_VAR^^}",
      'COMMAND_KEY="$(hostname)"',
      "OTHER_KEY=$SOME_SHELL_VAR",
      "CURLY_KEY=${ANOTHER_VAR}",
      "REAL_KEY=actual_value_here",
    ].join("\n");

    await withDotEnv(content, async (dir) => {
      const result = readStateDirDotEnvFromStateDir(dir).entries;
      expect(Object.keys(result)).not.toContain("SUPERMEMORY_OPENCLAW_API_KEY");
      expect(Object.keys(result)).not.toContain("QUOTED_SUPERMEMORY_OPENCLAW_API_KEY");
      expect(Object.keys(result)).not.toContain("QUOTED_CURLY_KEY");
      expect(Object.keys(result)).not.toContain("BRACE_DEFAULT_KEY");
      expect(Object.keys(result)).not.toContain("QUOTED_BRACE_DEFAULT_KEY");
      expect(Object.keys(result)).not.toContain("BRACE_TRIM_KEY");
      expect(Object.keys(result)).not.toContain("BRACE_REPLACE_KEY");
      expect(Object.keys(result)).not.toContain("BRACE_CASE_KEY");
      expect(Object.keys(result)).not.toContain("COMMAND_KEY");
      expect(Object.keys(result)).not.toContain("OTHER_KEY");
      expect(Object.keys(result)).not.toContain("CURLY_KEY");
      expect(result["REAL_KEY"]).toBe("actual_value_here");
    });
  });

  it("preserves credential values that merely contain a dollar sign", async () => {
    const content = [
      "PASSWORD=abc$2!xyz",
      "TOKEN=tok_$prod_v2",
      "PRICE=\\$100",
      "QUOTED_PASSWORD='\"abc$2!xyz\"'",
      "QUOTED_PRICE='\"$100\"'",
      "LEADING_DOLLAR_PASSWORD=$ecret123",
      "LEADING_DOLLAR_TOKEN=$token_1",
      "LOWERCASE_BRACE=${lowercase_literal}",
      "PURE_REF=$SOME_VAR",
    ].join("\n");

    await withDotEnv(content, async (dir) => {
      const result = readStateDirDotEnvFromStateDir(dir).entries;
      expect(result["PASSWORD"]).toBe("abc$2!xyz");
      expect(result["TOKEN"]).toBe("tok_$prod_v2");
      expect(result["PRICE"]).toBe("\\$100");
      expect(result["QUOTED_PASSWORD"]).toBe('"abc$2!xyz"');
      expect(result["QUOTED_PRICE"]).toBe('"$100"');
      expect(result["LEADING_DOLLAR_PASSWORD"]).toBe("$ecret123");
      expect(result["LEADING_DOLLAR_TOKEN"]).toBe("$token_1");
      expect(result["LOWERCASE_BRACE"]).toBe("${lowercase_literal}");
      expect(Object.keys(result)).not.toContain("PURE_REF");
    });
  });

  it("returns empty object when .env is missing", async () => {
    await withTempHome(async (home) => {
      expect(readStateDirDotEnvFromStateDir(path.join(home, ".openclaw")).entries).toEqual({});
    });
  });
});
