/**
 * Real behavior proof: parseMinimaxMusicStreamFrame malformed JSON → descriptive Error.
 *
 * Calls parseMinimaxMusicStreamFrame with malformed, valid, and edge-case SSE frame
 * JSON strings, exercising the ACTUAL changed code path. Verifies malformed SSE
 * data produces descriptive Error instead of raw SyntaxError.
 *
 * Usage: node --import tsx test/_proof_minimax_music_json_guard.mts
 */
import { parseMinimaxMusicStreamFrame } from "../extensions/minimax/music-generation-provider.js";

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
console.log("\n[1] malformed SSE frame JSON → descriptive Error");
{
  let error: unknown;
  try {
    parseMinimaxMusicStreamFrame("NOT JSON {{{");
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error (not SyntaxError)",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
  check(
    'message includes "malformed SSE JSON frame"',
    error instanceof Error && error.message.includes("malformed SSE JSON frame"),
    `message: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// ── 2. Valid MiniMax music frame → returns correctly ──
console.log("\n[2] valid MiniMax music frame → returns correctly");
{
  let error: unknown;
  let result: unknown;
  try {
    result = parseMinimaxMusicStreamFrame(
      '{"data":{"status":1,"audio":"49443304"},"base_resp":{"status_code":0}}',
    );
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown", error === undefined, String(error));
  check("returns object", result !== null && typeof result === "object", `type: ${typeof result}`);
  check(
    "audio hex preserved",
    (result as Record<string, unknown>)?.data?.audio === "49443304",
    JSON.stringify(result),
  );
  check(
    "base_resp.status_code is 0",
    (result as Record<string, unknown>)?.base_resp?.status_code === 0,
    JSON.stringify(result),
  );
}

// ── 3. Empty string → throws Error ──
console.log("\n[3] empty string → throws Error");
{
  let error: unknown;
  try {
    parseMinimaxMusicStreamFrame("");
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error for empty string",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
}

// ── 4. Non-object JSON (e.g. string) → parses but type is wrong ──
console.log("\n[4] non-object JSON → parses (type check is caller's responsibility)");
{
  let error: unknown;
  let result: unknown;
  try {
    result = parseMinimaxMusicStreamFrame('"just a string"');
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown for valid JSON string", error === undefined, String(error));
  check("returns the parsed string value", result === "just a string", String(result));
}

// ── Summary ──
console.log(`\n${"=".repeat(50)}`);
console.log(`  Passed: ${pass}  Failed: ${fail}  Total: ${pass + fail}`);
console.log(`${"=".repeat(50)}\n`);

if (fail > 0) {
  process.exit(1);
}
