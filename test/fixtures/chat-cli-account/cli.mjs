#!/usr/bin/env node
// Self-authored local CLI protocol fixture. This is not a Google/vendor binary.
import { appendFile } from "node:fs/promises";
if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0\n");
  process.exit(0);
}
const receipt = process.env.OPENCLAW_CHAT_AUTH_PROOF_RECEIPT;
if (!receipt) throw new Error("Task-owned receipt path missing");
await appendFile(receipt, JSON.stringify({ kind: "launch", runtime: "node-fixture" }) + "\n");
process.stdout.write(
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: "Synthetic CLI reply.",
    delta: true,
  }) + "\n",
);
process.stdout.write(
  JSON.stringify({ type: "result", status: "success", session_id: "synthetic-native-session" }) +
    "\n",
);
