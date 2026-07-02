/**
 * Real behavior proof: parseDiscordGatewayInfoBody malformed JSON → descriptive Error.
 *
 * Calls parseDiscordGatewayInfoBody with malformed, valid, and edge-case Discord
 * gateway bot info JSON bodies, exercising the ACTUAL changed code path.
 * Verifies malformed body produces descriptive Error instead of raw SyntaxError.
 *
 * Usage: node --import tsx test/_proof_discord_gateway_metadata_json_guard.mts
 */
import { parseDiscordGatewayInfoBody } from "../extensions/discord/src/monitor/gateway-metadata.js";

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
console.log("\n[1] malformed gateway info body → descriptive Error");
{
  let error: unknown;
  try {
    parseDiscordGatewayInfoBody("NOT JSON {{{");
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

// ── 2. Valid gateway info body → returns correctly ──
console.log("\n[2] valid gateway info body → returns correctly");
{
  let error: unknown;
  let result: unknown;
  try {
    result = parseDiscordGatewayInfoBody(
      JSON.stringify({
        url: "wss://gateway.discord.gg/",
        shards: 1,
        session_start_limit: { total: 1000, remaining: 999, reset_after: 3600000, max_concurrency: 1 },
      }),
    );
  } catch (err: unknown) {
    error = err;
  }
  check("no error thrown", error === undefined, String(error));
  check("returns object", result !== null && typeof result === "object", `type: ${typeof result}`);
  check(
    "url preserved",
    (result as Record<string, unknown>)?.url === "wss://gateway.discord.gg/",
    JSON.stringify(result),
  );
  check(
    "shards preserved",
    (result as Record<string, unknown>)?.shards === 1,
    JSON.stringify(result),
  );
}

// ── 3. Empty string → throws Error ──
console.log("\n[3] empty string → throws Error");
{
  let error: unknown;
  try {
    parseDiscordGatewayInfoBody("");
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error for empty body",
    error instanceof Error && !(error instanceof SyntaxError),
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
}

// ── 4. Valid JSON but wrong schema → still validates ──
console.log("\n[4] valid JSON but wrong schema → schema validation error");
{
  let error: unknown;
  try {
    parseDiscordGatewayInfoBody(JSON.stringify({ unknown_field: true }));
  } catch (err: unknown) {
    error = err;
  }
  check(
    "throws Error for schema mismatch",
    error instanceof Error,
    `error type: ${error?.constructor?.name ?? String(error)}`,
  );
  check(
    "message is schema error (not JSON parse error)",
    error instanceof Error && !error.message.includes("not valid JSON"),
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
