/**
 * Real runtime proof for #93917 / PR #94050.
 *
 * Runs the production detectToolCallLoop code path WITHOUT vitest — direct
 * Node.js execution through the real module tree. Simulates a stuck
 * docker/SSH failed-exec loop and shows the circuit breaker firing.
 *
 * Usage:
 *   /path/to/tsx src/agents/tool-loop-detection-runtime-proof.mts
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mod = require("./tool-loop-detection.js") as typeof import("./tool-loop-detection.js");

const {
  GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} = mod;

interface State {
  lastActivity: number;
  state: string;
  queueDepth: number;
}

function recordCall(
  state: State,
  toolName: string,
  params: unknown,
  result: unknown,
  idx: number,
) {
  const id = `${toolName}-${idx}`;
  recordToolCall(
    state as Parameters<typeof recordToolCall>[0],
    toolName,
    params,
    id,
  );
  recordToolCallOutcome(
    state as Parameters<typeof recordToolCallOutcome>[0],
    { toolName, toolParams: params, toolCallId: id, result },
  );
}

const ENABLED = { enabled: true };

console.log(
  "=== Real runtime proof: failed-exec loop detection (#93917) ===\n",
);

// ── Prove 1: Same failure fingerprint → circuit breaker ──
console.log(
  "Prove 1: Repeated docker-ps failures (same failureKind, varying error text)",
);
const state1: State = {
  lastActivity: Date.now(),
  state: "processing",
  queueDepth: 0,
};

for (let i = 0; i < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; i++) {
  recordCall(
    state1,
    "exec",
    { command: "docker ps" },
    {
      content: [
        {
          type: "text",
          text:
            "error: dial unix /var/run/docker.sock: " +
            `connect: connection refused (attempt ${i})`,
        },
      ],
      details: {
        status: "failed",
        exitCode: 1,
        failureKind: "connection_refused",
        timedOut: false,
      },
    },
    i,
  );
}

const r1 = detectToolCallLoop(
  state1,
  "exec",
  { command: "docker ps" },
  ENABLED,
);
console.log(
  `  stuck=${r1.stuck}  level=${(r1 as { level?: string }).level}  ` +
    `detector=${(r1 as { detector?: string }).detector}`,
);
console.log(
  `  VERDICT: ${
    (r1 as { level?: string }).level === "critical" &&
    (r1 as { detector?: string }).detector === "global_circuit_breaker"
      ? "PASS ✅ — circuit breaker triggered"
      : "FAIL ❌"
  }`,
);
console.log();

// ── Prove 2: Completed exec with varying output → warning only ──
console.log(
  "Prove 2: Repeated date calls (completed, varying output)",
);
const state2: State = {
  lastActivity: Date.now(),
  state: "processing",
  queueDepth: 0,
};

for (let i = 0; i < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; i++) {
  recordCall(
    state2,
    "exec",
    { command: "date" },
    {
      content: [
        {
          type: "text",
          text:
            `Mon Jun ${20 + (i % 7)} 10:${String(i).padStart(2, "0")}:00 ` +
            `UTC 2026`,
        },
      ],
      details: {
        status: "completed",
        exitCode: 0,
        aggregated: `tick ${i}`,
        timedOut: false,
      },
    },
    i,
  );
}

const r2 = detectToolCallLoop(
  state2,
  "exec",
  { command: "date" },
  ENABLED,
);
console.log(
  `  stuck=${r2.stuck}  level=${(r2 as { level?: string }).level}  ` +
    `detector=${(r2 as { detector?: string }).detector}`,
);
console.log(
  `  VERDICT: ${
    (r2 as { level?: string }).level === "warning" &&
    (r2 as { detector?: string }).detector !== "global_circuit_breaker"
      ? "PASS ✅ — varying completed output stays at warning"
      : "FAIL ❌"
  }`,
);
console.log();

// ── Prove 3: Different failureKind → still below breaker ──
console.log(
  "Prove 3: Mixed failure kinds (timeout/terminated/connection_refused)",
);
const state3: State = {
  lastActivity: Date.now(),
  state: "processing",
  queueDepth: 0,
};

const kinds = ["timeout", "terminated", "connection_refused"];
let ci = 0;
for (const kind of kinds) {
  for (
    let i = 0;
    i < Math.floor(GLOBAL_CIRCUIT_BREAKER_THRESHOLD / kinds.length);
    i++
  ) {
    recordCall(
      state3,
      "exec",
      { command: "flaky" },
      {
        content: [{ type: "text", text: `${kind} error at attempt ${i}` }],
        details: { status: "failed", exitCode: 1, failureKind: kind },
      },
      ci++,
    );
  }
}

const r3 = detectToolCallLoop(
  state3,
  "exec",
  { command: "flaky" },
  ENABLED,
);
console.log(
  `  stuck=${r3.stuck}  level=${(r3 as { level?: string }).level}  ` +
    `detector=${(r3 as { detector?: string }).detector}`,
);
console.log(
  `  VERDICT: ${
    (r3 as { level?: string }).level !== "critical"
      ? "PASS ✅ — distinct failure modes not merged"
      : "FAIL ❌"
  }`,
);
console.log();

// ── Prove 4: Numeric exitSignal preserved ──
console.log(
  "Prove 4: Numeric exitSignal (9=SIGKILL) vs string (SIGTERM)",
);
const state4: State = {
  lastActivity: Date.now(),
  state: "processing",
  queueDepth: 0,
};

for (
  let i = 0;
  i < Math.floor(GLOBAL_CIRCUIT_BREAKER_THRESHOLD / 2);
  i++
) {
  recordCall(
    state4,
    "exec",
    { command: "flaky" },
    {
      content: [{ type: "text", text: `SIGTERM at attempt ${i}` }],
      details: {
        status: "failed",
        exitCode: null,
        failureKind: "terminated",
        exitSignal: "SIGTERM",
      },
    },
    i,
  );
}
for (
  let i = Math.floor(GLOBAL_CIRCUIT_BREAKER_THRESHOLD / 2);
  i < GLOBAL_CIRCUIT_BREAKER_THRESHOLD;
  i++
) {
  recordCall(
    state4,
    "exec",
    { command: "flaky" },
    {
      content: [{ type: "text", text: `signal 9 at attempt ${i}` }],
      details: {
        status: "failed",
        exitCode: null,
        failureKind: "terminated",
        exitSignal: 9,
      },
    },
    i,
  );
}

const r4 = detectToolCallLoop(
  state4,
  "exec",
  { command: "flaky" },
  ENABLED,
);
console.log(
  `  stuck=${r4.stuck}  level=${(r4 as { level?: string }).level}  ` +
    `detector=${(r4 as { detector?: string }).detector}`,
);
console.log(
  `  VERDICT: ${
    (r4 as { level?: string }).level !== "critical"
      ? "PASS ✅ — numeric and string exitSignals kept distinct"
      : "FAIL ❌"
  }`,
);
console.log();

console.log("=== All runtime proofs complete ===");
