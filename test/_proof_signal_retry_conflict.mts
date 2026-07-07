/**
 * Real behavior proof: Signal dispatchWithRetryOnConflict retry logic.
 *
 * Calls the actual exported dispatchWithRetryOnConflict function with a
 * controlled handler that simulates "reply session initialization
 * conflicted" errors, exercising the real retry-with-backoff code path.
 *
 * Usage: node --import tsx test/_proof_signal_retry_conflict.mts
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

async function proofRetryOnConflict() {
  const { dispatchWithRetryOnConflict } =
    await import("../extensions/signal/src/monitor/event-handler.js");

  // ---- Scenario 1: two conflicts then success ----
  let callCount = 0;
  const twoConflictHandler = async () => {
    callCount++;
    if (callCount <= 2) {
      throw new Error(
        "reply session initialization conflicted for agent:main:signal:direct:proof",
      );
    }
  };

  await dispatchWithRetryOnConflict(twoConflictHandler);
  check(
    "two conflicts then success: 3 total calls",
    callCount === 3,
    `calls=${callCount}`,
  );

  // ---- Scenario 2: always conflicts, exhausts retries ----
  let alwaysCallCount = 0;
  const alwaysConflictHandler = async () => {
    alwaysCallCount++;
    throw new Error(
      "reply session initialization conflicted for agent:main:signal:direct:proof",
    );
  };

  let alwaysError: unknown;
  try {
    await dispatchWithRetryOnConflict(alwaysConflictHandler);
    check(
      "always conflicts: should throw",
      false,
      "expected error was not thrown",
    );
  } catch (err: unknown) {
    alwaysError = err;
  }

  check(
    "always conflicts: error propagated",
    alwaysError instanceof Error &&
      alwaysError.message.includes("reply session initialization conflicted"),
    `err=${String(alwaysError)}`,
  );

  check(
    "always conflicts: 4 total calls (1 initial + 3 retries)",
    alwaysCallCount === 4,
    `calls=${alwaysCallCount}`,
  );

  // ---- Scenario 3: non-conflict error passes through immediately ----
  let nonConflictCalls = 0;
  const nonConflictHandler = async () => {
    nonConflictCalls++;
    throw new Error("some unrelated error");
  };

  let nonConflictError: unknown;
  try {
    await dispatchWithRetryOnConflict(nonConflictHandler);
    check(
      "non-conflict error: should throw",
      false,
      "expected error was not thrown",
    );
  } catch (err: unknown) {
    nonConflictError = err;
  }

  check(
    "non-conflict error: propagated",
    nonConflictError instanceof Error &&
      nonConflictError.message === "some unrelated error",
    `err=${String(nonConflictError)}`,
  );

  check(
    "non-conflict error: only 1 call (no retry)",
    nonConflictCalls === 1,
    `calls=${nonConflictCalls}`,
  );

  // ---- Scenario 4: success on first attempt (no retry needed) ----
  let successCalls = 0;
  const successHandler = async () => {
    successCalls++;
  };

  await dispatchWithRetryOnConflict(successHandler);
  check(
    "success on first attempt: only 1 call",
    successCalls === 1,
    `calls=${successCalls}`,
  );

  // ---- Scenario 5: custom retry/backoff parameters ----
  let customCalls = 0;
  const customHandler = async () => {
    customCalls++;
    if (customCalls <= 2) {
      throw new Error("reply session initialization conflicted for proof");
    }
  };

  // 2 retries (3 total attempts max), 50ms base delay for faster test
  await dispatchWithRetryOnConflict(customHandler, 2, 50);
  check(
    "custom params (2 retries, 50ms): 3 total calls",
    customCalls === 3,
    `calls=${customCalls}`,
  );
}

async function main() {
  console.log(`node --import tsx test/_proof_signal_retry_conflict.mts\n`);
  await proofRetryOnConflict();
  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
