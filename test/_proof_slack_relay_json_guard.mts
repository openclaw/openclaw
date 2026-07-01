/**
 * Real behavior proof: Slack relay parseRelayFrame guards against
 * malformed JSON frames on the WebSocket transport.
 *
 * Calls parseRelayFrame directly with malformed input and
 * verifies it throws SlackRelayMalformedFrameError instead of
 * raw SyntaxError.
 *
 * Usage: node --import tsx test/_proof_slack_relay_json_guard.mts
 */

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
    fail++;
  }
}

async function main() {
  const {
    parseRelayFrame,
    SlackRelayMalformedFrameError,
  } = await import(
    "../extensions/slack/src/monitor/relay-source.js"
  );

  // Proof 1: malformed JSON throws SlackRelayMalformedFrameError
  {
    let error: unknown;
    try {
      parseRelayFrame("NOT JSON {{{");
    } catch (err: unknown) {
      error = err;
    }

    check(
      "malformed JSON frame: throws SlackRelayMalformedFrameError",
      error instanceof SlackRelayMalformedFrameError,
      `type=${error?.constructor?.name ?? "unknown"}`,
    );
    check(
      "malformed JSON frame: message describes malformed JSON",
      error instanceof SlackRelayMalformedFrameError &&
        error.message.includes("malformed JSON frame"),
      `msg=${
        error instanceof Error ? error.message.slice(0, 100) : "N/A"
      }`,
    );
    check(
      "malformed JSON frame: wraps original SyntaxError as cause",
      error instanceof SlackRelayMalformedFrameError &&
        error.cause !== undefined,
      `cause=${
        error instanceof SlackRelayMalformedFrameError
          ? (error.cause as Error)?.constructor?.name ?? "present"
          : "N/A"
      }`,
    );
  }

  // Proof 2: valid JSON still parses correctly (no regression)
  {
    const result = parseRelayFrame(
      JSON.stringify({ type: "slack_event", data: { text: "hello" } }),
    );
    check(
      "valid JSON frame: parsed correctly",
      (result as Record<string, unknown>)?.type === "slack_event",
      `result=${JSON.stringify(result)}`,
    );
  }

  // Proof 3: empty object
  {
    const result = parseRelayFrame("{}");
    check(
      "empty JSON frame: parsed correctly",
      typeof result === "object" && result !== null,
      `result=${JSON.stringify(result)}`,
    );
  }

  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}
main();
