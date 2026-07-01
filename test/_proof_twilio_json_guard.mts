/**
 * Real behavior proof: Twilio malformed JSON → graceful handling.
 *
 * Calls listTwilioIncomingPhoneNumbers and retrieveTwilioMessagingService
 * with a custom fetchImpl that returns malformed JSON, exercising the actual
 * changed try/catch guards in parseTwilioListPayload and
 * retrieveTwilioMessagingService.  No vitest or vi.mock required.
 *
 * Usage: node --import tsx test/_proof_twilio_json_guard.mts
 */

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`); }
  else { fail++; console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
}

async function proofListPayloadMalformed() {
  const { listTwilioIncomingPhoneNumbers } = await import(
    "../extensions/sms/src/twilio.js"
  );

  // Custom fetchImpl returning malformed JSON
  const badFetch = async () =>
    new Response("NOT JSON {{{", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const result = await listTwilioIncomingPhoneNumbers({
    account: { accountSid: "AC-proof", authToken: "proof-token", fromNumber: "+15550001111" },
    fetchImpl: badFetch as typeof fetch,
  });

  check("listPayload malformed: returns [] (fail-safe)",
    Array.isArray(result) && result.length === 0,
    `result=${JSON.stringify(result)}`);
}

async function proofMessagingServiceMalformed() {
  const { retrieveTwilioMessagingService } = await import(
    "../extensions/sms/src/twilio.js"
  );

  const badFetch = async () =>
    new Response("NOT JSON {{{", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  let error: unknown;
  try {
    await retrieveTwilioMessagingService({
      account: { accountSid: "AC-proof", authToken: "proof-token", fromNumber: "+15550001111" },
      serviceSid: "MG-proof",
      fetchImpl: badFetch as typeof fetch,
    });
    check("messagingService malformed: throws", false, "should have thrown");
  } catch (err: unknown) {
    check("messagingService malformed: throws Error", err instanceof Error,
      `type=${err instanceof Error ? err.constructor.name : String(err)}`);
    if (err instanceof Error) {
      check("messagingService malformed: mentions malformed JSON",
        err.message.includes("malformed JSON"),
        `msg="${err.message}"`);
    }
  }
}

async function proofListPayloadValid() {
  const { listTwilioIncomingPhoneNumbers } = await import(
    "../extensions/sms/src/twilio.js"
  );

  const goodFetch = async () =>
    new Response(
      JSON.stringify({
        incoming_phone_numbers: [
          {
            sid: "PN123",
            phone_number: "+15550009999",
            friendly_name: "Test",
            sms_url: "https://example.com/webhook",
            sms_method: "POST",
            capabilities: { sms: true, mms: false },
          },
        ],
        page: 0,
        page_size: 50,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const result = await listTwilioIncomingPhoneNumbers({
    account: { accountSid: "AC-proof", authToken: "proof-token", fromNumber: "+15550001111" },
    fetchImpl: goodFetch as typeof fetch,
  });

  check("listPayload valid: parsed correctly",
    result.length === 1 && result[0]?.sid === "PN123",
    `count=${result.length} sid=${result[0]?.sid}`);
}

async function main() {
  console.log(`node --import tsx test/_proof_twilio_json_guard.mts\n`);
  await proofListPayloadMalformed();
  await proofMessagingServiceMalformed();
  await proofListPayloadValid();
  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
