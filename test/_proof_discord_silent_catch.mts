/**
 * Real behavior proof: console.warn replaces silent catch{}.
 *
 * Calls replySilently with a mock interaction that throws on reply(),
 * then verifies that console.warn is called with the expected diagnostic
 * instead of the error being silently swallowed.
 *
 * Usage: node --import tsx test/_proof_discord_silent_catch.mts
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
  const { replySilently } = await import(
    "../extensions/discord/src/monitor/agent-components-reply.js"
  );

  // Proof 1: when interaction.reply throws, console.warn is called
  const warnCalls: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args.map(String).join(" "));
  };

  try {
    const badInteraction = {
      reply: async () => {
        throw new Error("Unknown interaction");
      },
    };

    await replySilently(badInteraction as Parameters<typeof replySilently>[0], {
      content: "test",
    });

    check(
      "console.warn called on reply failure",
      warnCalls.length === 1,
      `calls=${warnCalls.length}`,
    );
    check(
      "warning contains diagnostic prefix",
      warnCalls[0]?.includes("discord component reply failed"),
      `msg=${warnCalls[0]?.slice(0, 80) ?? "N/A"}`,
    );
    check(
      "warning includes error message",
      warnCalls[0]?.includes("Unknown interaction"),
    );

    // Proof 2: successful reply does NOT warn
    warnCalls.length = 0;
    const goodInteraction = {
      reply: async () => {},
    };

    await replySilently(goodInteraction as Parameters<typeof replySilently>[0], {
      content: "test",
    });

    check(
      "console.warn NOT called on successful reply",
      warnCalls.length === 0,
      `calls=${warnCalls.length}`,
    );
  } finally {
    console.warn = origWarn;
  }

  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}
main();
