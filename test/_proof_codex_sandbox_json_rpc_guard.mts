/**
 * Real behavior proof: parseRequest malformed WebSocket data → descriptive Error.
 *
 * Calls parseRequest with malformed Buffer data, exercising the ACTUAL changed
 * code path. Verifies malformed WebSocket data produces descriptive Error
 * instead of raw SyntaxError.
 *
 * Usage: node --import tsx test/_proof_codex_sandbox_json_rpc_guard.mts
 */
import { parseRequest } from "../extensions/codex/src/app-server/sandbox-exec-server/json-rpc.js";

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

// ── 1. Malformed JSON Buffer → descriptive Error ──
console.log("\n[1] malformed JSON Buffer → descriptive Error");
{
  let error: unknown;
  try {
    parseRequest(Buffer.from("NOT JSON {{{"));
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error (not SyntaxError)",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
  check(
    'message includes "not valid JSON"',
    error instanceof Error && error.message.includes("not valid JSON"),
    `message: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// ── 2. Valid JSON-RPC request Buffer → returns correctly ──
console.log("\n[2] valid JSON-RPC request → returns correctly");
{
  let error: unknown;
  let result: unknown;
  try {
    result = parseRequest(
      Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "test", arguments: {} },
        id: 1,
      })),
    );
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown", error === undefined, String(error));
  check("returns object", result !== null && typeof result === "object", `type: ${typeof result}`);
  check(
    'method is "tools/call"',
    (result as Record<string,unknown>)?.method === "tools/call",
    JSON.stringify(result));
}

// ── 3. Empty Buffer → throws Error ──
console.log("\n[3] empty Buffer → throws Error");
{
  let error: unknown;
  try {
    parseRequest(Buffer.from(""));
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error for empty data",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
}

// ── 4. Valid JSON but wrong shape → object validation error ──
console.log("\n[4] valid JSON non-object → requireObject validation");
{
  let error: unknown;
  try {
    parseRequest(Buffer.from("[1,2,3]"));
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error for non-object JSON",
    error instanceof Error,
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
}

// ── Summary ──
console.log(`\n${"=".repeat(50)}`);
console.log(`  Passed: ${pass}  Failed: ${fail}  Total: ${pass + fail}`);
console.log(`${"=".repeat(50)}\n`);

if (fail > 0) {
  process.exit(1);
}
