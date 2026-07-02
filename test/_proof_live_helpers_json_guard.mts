/**
 * Real behavior proof: parseJsonStringArray malformed JSON → descriptive Error.
 *
 * Calls parseJsonStringArray with malformed, empty, non-array, and valid JSON
 * strings, exercising the ACTUAL changed code path. Verifies malformed JSON
 * produces descriptive Error instead of raw SyntaxError.
 *
 * Usage: npx tsx test/_proof_live_helpers_json_guard.mts
 */
import { parseJsonStringArray } from "../src/gateway/gateway-cli-backend.live-helpers.js";

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
console.log("\n[1] malformed JSON → descriptive Error");
{
  let error: unknown;
  try {
    parseJsonStringArray("TEST_MALFORMED", "NOT JSON {{{");
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error (not SyntaxError)",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
  check(
    "message includes the parameter name 'TEST_MALFORMED'",
    error instanceof Error && error.message.includes("TEST_MALFORMED"),
    `message: ${error instanceof Error ? error.message : String(error)}`,
  );
  check(
    "message includes 'must be a JSON array of strings'",
    error instanceof Error && error.message.includes("must be a JSON array of strings"),
    `message: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// ── 2. Valid JSON array → returns correctly ──
console.log("\n[2] valid JSON array → returns correctly");
{
  let error: unknown;
  let result: string[] | undefined;
  try {
    result = parseJsonStringArray("TEST_VALID", '["a","b","c"]');
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown", error === undefined, String(error));
  check("returns array", Array.isArray(result), `type: ${typeof result}`);
  check("returns correct values", JSON.stringify(result) === '["a","b","c"]', JSON.stringify(result));
}

// ── 3. Empty/undefined input → returns undefined ──
console.log("\n[3] empty/undefined input → returns undefined");
{
  let error: unknown;
  let result: string[] | undefined;
  try {
    result = parseJsonStringArray("TEST_EMPTY", "");
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown for empty string", error === undefined, String(error));
  check("returns undefined for empty string", result === undefined, `result: ${JSON.stringify(result)}`);

  error = undefined;
  result = undefined;
  try {
    result = parseJsonStringArray("TEST_UNDEFINED", undefined);
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown for undefined", error === undefined, String(error));
  check("returns undefined for undefined raw", result === undefined, `result: ${JSON.stringify(result)}`);
}

// ── 4. Non-array JSON → descriptive Error ──
console.log("\n[4] non-array JSON → descriptive Error");
{
  let error: unknown;
  try {
    parseJsonStringArray("TEST_NON_ARRAY", '{"key":"value"}');
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error (not SyntaxError)",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
  check(
    "message describes validation failure",
    error instanceof Error && error.message.includes("must be a JSON array of strings"),
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
