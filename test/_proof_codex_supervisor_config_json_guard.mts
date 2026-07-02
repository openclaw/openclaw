/**
 * Real behavior proof: loadCodexSupervisorEndpoints malformed env JSON → descriptive Error.
 *
 * Calls loadCodexSupervisorEndpoints with malformed OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS env values,
 * exercising the ACTUAL changed code path. Verifies malformed JSON produces
 * descriptive Error instead of raw SyntaxError.
 *
 * Usage: node --import tsx test/_proof_codex_supervisor_config_json_guard.mts
 */
import { loadCodexSupervisorEndpoints } from "../extensions/codex-supervisor/src/config.js";

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

// ── 1. Malformed JSON array env → descriptive Error ──
console.log("\n[1] malformed JSON array env → descriptive Error");
{
  let error: unknown;
  try {
    loadCodexSupervisorEndpoints({ OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS: "[NOT JSON {{{" });
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error (not SyntaxError)",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
  check(
    "message includes 'must be a valid JSON array'",
    error instanceof Error && error.message.includes("must be a valid JSON array"),
    `message: ${error instanceof Error ? error.message : String(error)}`,
  );
  check(
    "message includes env var name OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS",
    error instanceof Error && error.message.includes("OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS"),
    `message: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// ── 2. Valid JSON array env → returns correctly ──
console.log("\n[2] valid JSON array env → returns correctly");
{
  let error: unknown;
  let result: unknown;
  try {
    result = loadCodexSupervisorEndpoints({
      OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS: JSON.stringify([
        { id: "test", label: "Test", transport: "websocket", url: "ws://localhost:9999" },
      ]),
    });
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown", error === undefined, String(error));
  check("returns array", Array.isArray(result), `type: ${typeof result}`);
  check("returns 1 endpoint", (result as unknown[])?.length === 1, String((result as unknown[])?.length));
}

// ── 3. Empty env → returns default local endpoint ──
console.log("\n[3] empty env → returns default local endpoint");
{
  let error: unknown;
  let result: unknown;
  try {
    result = loadCodexSupervisorEndpoints({});
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown", error === undefined, String(error));
  check("returns default 'local' endpoint",
    Array.isArray(result) && (result as Array<{id: string}>)[0]?.id === "local",
    JSON.stringify(result));
}

// ── Summary ──
console.log(`\n${"=".repeat(50)}`);
console.log(`  Passed: ${pass}  Failed: ${fail}  Total: ${pass + fail}`);
console.log(`${"=".repeat(50)}\n`);

if (fail > 0) {
  process.exit(1);
}
