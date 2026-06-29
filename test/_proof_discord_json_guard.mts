/**
 * Real behavior proof: requestDiscord malformed JSON → DiscordApiError.
 *
 * Calls requestDiscord with a custom fetcher that returns malformed JSON
 * with HTTP 200, exercising the actual changed code path (the try/catch
 * around JSON.parse).  Verifies the malformed body produces a
 * DiscordApiError instead of a raw SyntaxError.
 *
 * Usage: node --import tsx test/_proof_discord_json_guard.mts
 */

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`); }
  else { fail++; console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
}

async function proofMalformedJson() {
  const { DiscordApiError, requestDiscord } = await import(
    "../extensions/discord/src/api.js"
  );

  // Custom fetcher that always returns malformed JSON
  const badFetcher = async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response("NOT JSON {{{", { status: 200 });

  let error: unknown;
  try {
    await requestDiscord<{ id: string }>("/users/@me", "proof-token", {
      fetcher: badFetcher as typeof fetch,
      retry: { attempts: 1 },
    });
    check("malformed JSON: throws", false, "should have thrown");
  } catch (err: unknown) {
    check("malformed JSON: throws DiscordApiError", err instanceof DiscordApiError,
      `type=${err instanceof Error ? err.constructor.name : String(err)}`);
    if (err instanceof DiscordApiError) {
      check("malformed JSON: message describes malformed JSON",
        String(err.message).includes("malformed JSON"),
        `msg="${err.message}"`);
      check("malformed JSON: status=0 (not retryable)", err.status === 0,
        `status=${err.status}`);
    }
  }
}

async function proofRateLimitStillWorks() {
  const { DiscordApiError, requestDiscord } = await import(
    "../extensions/discord/src/api.js"
  );

  const rateLimitFetcher = async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      JSON.stringify({ message: "rate limited", retry_after: 1.5, global: false }),
      { status: 429, headers: { "content-type": "application/json" } },
    );

  let error: unknown;
  try {
    await requestDiscord<{ id: string }>("/users/@me", "proof-token", {
      fetcher: rateLimitFetcher as typeof fetch,
      retry: { attempts: 1 },
    });
  } catch (err: unknown) {
    error = err;
  }

  check("rate-limit: still throws DiscordApiError", error instanceof DiscordApiError,
    `type=${error instanceof Error ? error.constructor.name : String(error)}`);
  if (error instanceof DiscordApiError) {
    check("rate-limit: status preserved", error.status === 429, `status=${error.status}`);
  }
}

async function proofValidJsonStillWorks() {
  const { requestDiscord } = await import(
    "../extensions/discord/src/api.js"
  );

  const goodFetcher = async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ id: "42", name: "test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const result = await requestDiscord<{ id: string; name: string }>(
    "/users/@me",
    "proof-token",
    { fetcher: goodFetcher as typeof fetch, retry: { attempts: 1 } },
  );

  check("valid JSON: parsed correctly", result?.id === "42" && result?.name === "test",
    `result=${JSON.stringify(result)}`);
}

async function main() {
  console.log(`node --import tsx test/_proof_discord_json_guard.mts\n`);
  await proofMalformedJson();
  await proofRateLimitStillWorks();
  await proofValidJsonStillWorks();
  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
