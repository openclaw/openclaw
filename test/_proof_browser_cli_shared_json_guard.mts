/**
 * Real behavior proof: readFields malformed JSON input → descriptive Error.
 *
 * Calls readFields with malformed fields strings, exercising the ACTUAL changed
 * code path. Verifies malformed user input produces descriptive Error
 * instead of raw SyntaxError.
 *
 * Usage: node --import tsx test/_proof_browser_cli_shared_json_guard.mts
 */
import { readFields } from "../extensions/browser/src/cli/browser-cli-actions-input/shared.js";

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail: string) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}: ${detail}`);
    fail++;
  }
}

// ── 1. Malformed JSON → descriptive Error ──
console.log("\n[1] malformed JSON fields → descriptive Error");
{
  let error: unknown;
  try {
    await readFields({ fields: "NOT JSON {{{" });
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error (not SyntaxError)",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
  check(
    'message includes "must be valid JSON"',
    error instanceof Error && error.message.includes("must be valid JSON"),
    `message: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// ── 2. Valid JSON array → returns correctly ──
console.log("\n[2] valid JSON fields array → returns correctly");
{
  let error: unknown;
  let result: unknown;
  try {
    result = await readFields({
      fields: JSON.stringify([
        { ref: "input[name=q]", value: "hello" },
      ]),
    });
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown", error === undefined, String(error));
  check("returns array", Array.isArray(result), `type: ${typeof result}`);
  check("returns 1 field", (result as unknown[])?.length === 1, String((result as unknown[])?.length));
}

// ── 3. Empty string → throws validation Error ──
console.log("\n[3] empty fields string → throws validation Error");
{
  let error: unknown;
  try {
    await readFields({ fields: "" });
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error for empty fields",
    error instanceof Error,
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
}

// ── 4. Valid JSON non-array → throws validation Error ──
console.log("\n[4] valid JSON non-array → throws validation Error");
{
  let error: unknown;
  try {
    await readFields({ fields: '{"not":"array"}' });
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error for non-array",
    error instanceof Error,
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
  check(
    "message is schema error (not JSON parse error)",
    error instanceof Error && !error.message.includes("must be valid JSON"),
    `message: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// ── Summary ──
console.log(`\n${"=".repeat(50)}`);
console.log(`  Passed: ${pass}  Failed: ${fail}  Total: ${pass + fail}`);
console.log(`${"=".repeat(50)}\n`);

if (fail > 0) {
  process.exit(1);
}
