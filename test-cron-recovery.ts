// Quick runtime probe for PR #88460 - cron llamacpp param recovery
import { normalizeCronJobCreate } from "./src/cron/normalize.js";

// Simulate corrupted input from local-llamacpp model
const corruptedInput = {
  delivery: { mode: "none" },
  enabled: true,
  namePayload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
  scheduleKind: { everyMs: 999999, kind: "every" },
  sessionTargetName: "evidence-test",
};

console.log("Input (corrupted):", JSON.stringify(corruptedInput, null, 2));

const result = normalizeCronJobCreate(corruptedInput);
console.log("\nOutput (recovered):", JSON.stringify(result, null, 2));

// Verify recovery
const checks = [
  { name: "name recovered", pass: result.name === "evidence-test" },
  { name: "payload extracted", pass: result.payload?.kind === "agentTurn" && result.payload?.message === "Evidence test." },
  { name: "schedule extracted", pass: result.schedule?.kind === "every" && result.schedule?.everyMs === 999999 },
  { name: "sessionTarget restored", pass: result.sessionTarget === "isolated" },
  { name: "namePayload removed", pass: !("namePayload" in result) },
  { name: "scheduleKind removed", pass: !("scheduleKind" in result) },
  { name: "sessionTargetName removed", pass: !("sessionTargetName" in result) },
];

console.log("\nRecovery checks:");
let allPassed = true;
for (const check of checks) {
  console.log(`  ${check.pass ? "✅" : "❌"} ${check.name}`);
  if (!check.pass) allPassed = false;
}

console.log(allPassed ? "\n🎉 All checks passed!" : "\n❌ Some checks failed!");
process.exit(allPassed ? 0 : 1);
