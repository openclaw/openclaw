#!/usr/bin/env node

// Simple test to verify heartbeat fires
const { requestHeartbeatNow, setHeartbeatWakeHandler } = require("./dist/infra/heartbeat-wake.js");

let callCount = 0;

setHeartbeatWakeHandler(async ({ reason }) => {
  callCount++;
  console.log(`Heartbeat fired! Count: ${callCount}, Reason: ${reason}`);
  return { status: "ran", durationMs: 10 };
});

console.log("Test 1: Immediate heartbeat (coalesceMs: 0)");
requestHeartbeatNow({ reason: "test-immediate", coalesceMs: 0 });

setTimeout(() => {
  console.log("\nTest 2: Regular heartbeat with delay");
  requestHeartbeatNow({ reason: "test-delayed", coalesceMs: 100 });

  setTimeout(() => {
    console.log("\nTest 3: Urgent heartbeat should override delayed");
    requestHeartbeatNow({ reason: "test-urgent", coalesceMs: 0 });
  }, 50);
}, 100);

setTimeout(() => {
  console.log(`\nFinal count: ${callCount}`);
  console.log(callCount >= 3 ? "✅ Test PASSED" : "❌ Test FAILED");
  process.exit(callCount >= 3 ? 0 : 1);
}, 500);
