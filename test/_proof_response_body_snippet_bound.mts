/**
 * Real behavior proof: readResponseBodySnippet maxBytes enforcement.
 *
 * Calls the actual readResponseBodySnippet with a mock Response whose body
 * is null (simulating non-streaming / mocked transports), exercising the
 * fixed fallback path that now encodes → bounds → decodes instead of
 * buffering the entire response.text() without a byte limit.
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

/** Mock Response-like object with no body reader (hits the fallback). */
function nonStreamingMock(bodyText: string): Response {
  return {
    body: null,
    text: async () => bodyText,
  } as unknown as Response;
}

/** Real ReadableStream-backed Response (hits the streaming path). */
function streamingResponse(bodyText: string): Response {
  const encoded = new TextEncoder().encode(bodyText);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 400,
    headers: { "content-type": "text/plain" },
  });
}

async function proof() {
  const { readResponseBodySnippet } =
    await import("../src/infra/http-error-body.js");

  // ── Non-streaming: body exceeds maxBytes ──
  const largeBody = "x".repeat(10_000);
  const limits = { maxBytes: 200, maxChars: 500 };
  const nonStreamingRes = nonStreamingMock(largeBody);
  const snippet = await readResponseBodySnippet(nonStreamingRes, limits);

  check(
    "non-streaming: snippet ≤ maxChars",
    snippet.length <= limits.maxChars,
    `len=${snippet.length} max=${limits.maxChars}`,
  );
  const byteLen = new TextEncoder().encode(snippet).length;
  check(
    "non-streaming: byte length ≤ maxBytes",
    byteLen <= limits.maxBytes,
    `bytes=${byteLen} max=${limits.maxBytes}`,
  );

  // ── Non-streaming: small body passes through ──
  const smallBody = "hello";
  const smallRes = nonStreamingMock(smallBody);
  const smallSnippet = await readResponseBodySnippet(smallRes, {
    maxBytes: 10_000,
    maxChars: 10_000,
  });
  check(
    "non-streaming small: passes through",
    smallSnippet === smallBody,
    `got="${smallSnippet}"`,
  );

  // ── Streaming: body exceeds maxBytes ──
  const largeStreamingBody = "y".repeat(10_000);
  const streamingRes = streamingResponse(largeStreamingBody);
  const streamSnippet = await readResponseBodySnippet(streamingRes, limits);

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

  // ── Streaming: small body ──
  const smallStreamRes = streamingResponse("world");
  const smallStreamSnippet = await readResponseBodySnippet(smallStreamRes, {
    maxBytes: 10_000,
    maxChars: 10_000,
  });
  check(
    "streaming small: passes through",
    smallStreamSnippet === "world",
    `got="${smallStreamSnippet}"`,
  );

  // ── Multibyte CJK not corrupted by byte-boundary truncation ──
  const cjkBody = "啊".repeat(500); // 3 bytes each in UTF-8
  const cjkLimits = { maxBytes: 15, maxChars: 100 };
  const cjkNonStreamingRes = nonStreamingMock(cjkBody);
  const cjkSnippet = await readResponseBodySnippet(
    cjkNonStreamingRes,
    cjkLimits,
  );
  const cjkByteLen = new TextEncoder().encode(cjkSnippet).length;
  check(
    "multibyte non-streaming: bytes ≤ maxBytes",
    cjkByteLen <= cjkLimits.maxBytes,
    `bytes=${cjkByteLen} max=${cjkLimits.maxBytes}`,
  );
  check(
    "multibyte non-streaming: chars ≤ maxChars",
    cjkSnippet.length <= cjkLimits.maxChars,
    `chars=${cjkSnippet.length} max=${cjkLimits.maxChars}`,
  );
  // subarray may split a multibyte character; the decoder replaces that
  // trailing fragment with U+FFFD (�).  Verify we strip it.
  check(
    "multibyte non-streaming: no replacement character",
    !cjkSnippet.includes("�"),
    `snippet="${cjkSnippet}"`,
  );
}

async function main() {
  console.log(
    `node --import tsx test/_proof_response_body_snippet_bound.mts\n`,
  );
  await proof();
  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
