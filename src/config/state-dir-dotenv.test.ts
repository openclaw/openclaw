import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: logWarnSpy }),
}));
import { readStateDirDotEnvFromStateDir } from "./state-dir-dotenv.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
});
afterEach(async () => {
  logWarnSpy.mockClear();
  await fs.rm(dir, { recursive: true, force: true });
});
const write = (content: string | Buffer) => fs.writeFile(path.join(dir, ".env"), content);
const read = () => readStateDirDotEnvFromStateDir(dir).entries;

it("skips values that are unresolved shell variable references", async () => {
  await write(
    [
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
    ].join("\n"),
  );
  expect(read()).toEqual({ REAL_KEY: "actual_value_here" });
});

it("preserves credential values that merely contain a dollar sign", async () => {
  const values = {
    PASSWORD: ["abc$2!xyz", "abc$2!xyz"],
    TOKEN: ["tok_$prod_v2", "tok_$prod_v2"],
    PRICE: ["\\$100", "\\$100"],
    QUOTED_PASSWORD: ["'\"abc$2!xyz\"'", '"abc$2!xyz"'],
    QUOTED_PRICE: ["'\"$100\"'", '"$100"'],
    LEADING_DOLLAR_PASSWORD: ["$ecret123", "$ecret123"],
    LEADING_DOLLAR_TOKEN: ["$token_1", "$token_1"],
    LOWERCASE_BRACE: ["${lowercase_literal}", "${lowercase_literal}"],
  };
  await write(
    [...Object.entries(values).map(([key, [raw]]) => `${key}=${raw}`), "PURE_REF=$SOME_VAR"].join(
      "\n",
    ),
  );
  expect(read()).toEqual(
    Object.fromEntries(Object.entries(values).map(([key, [, parsed]]) => [key, parsed])),
  );
});

it("returns empty object when .env is missing", () => {
  expect(read()).toEqual({});
});

it("reads a symlinked .env file", async () => {
  const realPath = path.join(dir, "real.env");
  await fs.writeFile(realPath, "REAL_KEY=from_symlink_target\n", "utf8");
  await fs.symlink(realPath, path.join(dir, ".env"));
  expect(read().REAL_KEY).toBe("from_symlink_target");
});

it("warns when an oversized .env is skipped", async () => {
  const large = Buffer.alloc(2 * 1024 * 1024, "x");
  large.write("KEY=value\n", 0, "utf8");
  await write(large);
  expect(read()).toEqual({});
  expect(logWarnSpy).toHaveBeenCalledWith(
    expect.stringContaining("skipping oversized state-directory .env file"),
  );
});
