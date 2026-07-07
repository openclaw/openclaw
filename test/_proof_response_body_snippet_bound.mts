/**
 * Real behavior proof: readResponseBodySnippet fail-closed fallback.
 *
 * When the response body has no reader (non-streaming/mocked responses),
 * the function now returns "" instead of calling response.text() which
 * would buffer the full body before maxBytes can be applied.
 *
 * Usage: node --import tsx test/_proof_response_body_snippet_bound.mts
 */

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** Mock Response with null body — hits the fail-closed fallback. */
function nonStreamingMock(bodyText: string): Response {
  return {
    body: null,
    text: async () => bodyText,
  } as unknown as Response;
}

/** ReadableStream-backed Response — hits the bounded streaming path. */
function streamingResponse(bodyText: string): Response {
  const encoded = new TextEncoder().encode(bodyText);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    }),
    { status: 400, headers: { "content-type": "text/plain" } },
  );
}

async function proof() {
  const { readResponseBodySnippet } = await import(
    "../src/infra/http-error-body.js"
  );

  // ── Non-streaming: fails closed, returns "" ──
  const largeBody = "x".repeat(10_000);
  const nonStreamingRes = nonStreamingMock(largeBody);
  const snippet = await readResponseBodySnippet(nonStreamingRes, {
    maxBytes: 200,
    maxChars: 500,
  });
  check(
    "non-streaming fail-closed: returns empty string",
    snippet === "",
    `len=${snippet.length}`,
  );

  // ── Non-streaming: even small bodies fail closed ──
  const smallRes = nonStreamingMock("hello");
  const smallSnippet = await readResponseBodySnippet(smallRes, {
    maxBytes: 10_000,
    maxChars: 10_000,
  });
  check(
    "non-streaming small: also returns empty (fail-closed)",
    smallSnippet === "",
    `got="${smallSnippet}"`,
  );

  // ── Streaming: body exceeds maxBytes ──
  const largeStreamingBody = "y".repeat(10_000);
  const limits = { maxBytes: 200, maxChars: 500 };
  const streamSnippet = await readResponseBodySnippet(
    streamingResponse(largeStreamingBody),
    limits,
  );
  check(
    "streaming: snippet ≤ maxChars",
    streamSnippet.length <= limits.maxChars,
    `len=${streamSnippet.length} max=${limits.maxChars}`,
  );
  const streamByteLen = new TextEncoder().encode(streamSnippet).length;
  check(
    "streaming: byte length ≤ maxBytes",
    streamByteLen <= limits.maxBytes,
    `bytes=${streamByteLen} max=${limits.maxBytes}`,
  );

  // ── Streaming: small body passes through ──
  const smallStreamSnippet = await readResponseBodySnippet(
    streamingResponse("world"),
    { maxBytes: 10_000, maxChars: 10_000 },
  );
  check(
    "streaming small: passes through",
    smallStreamSnippet === "world",
    `got="${smallStreamSnippet}"`,
  );

  // ── Streaming: multibyte CJK not corrupted ──
  const cjkStreamSnippet = await readResponseBodySnippet(
    streamingResponse("啊".repeat(500)),
    { maxBytes: 15, maxChars: 100 },
  );
  const cjkByteLen = new TextEncoder().encode(cjkStreamSnippet).length;
  check(
    "streaming multibyte: bytes ≤ maxBytes",
    cjkByteLen <= 15,
    `bytes=${cjkByteLen} max=15`,
  );
  check(
    "streaming multibyte: chars ≤ maxChars",
    cjkStreamSnippet.length <= 100,
    `chars=${cjkStreamSnippet.length} max=100`,
  );
  check(
    "streaming multibyte: no replacement char",
    !cjkStreamSnippet.includes("�"),
    `snippet="${cjkStreamSnippet}"`,
  );
}

async function main() {
  console.log(`node --import tsx test/_proof_response_body_snippet_bound.mts\n`);
  await proof();
  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
