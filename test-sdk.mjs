// Raw test for @github/copilot-sdk cleanup behavior
import { CopilotClient } from "@github/copilot-sdk";

console.log("Creating client...");
const client = new CopilotClient({
  autoStart: false,
  autoRestart: false,
  logLevel: "warning",
});

console.log("Starting client...");
await client.start();

console.log("Creating session...");
const session = await client.createSession({ model: "gpt-4.1" });

console.log("Sending message...");
const result = await session.sendAndWait({ prompt: "Reply: OK" }, 30000);
console.log("Result:", result?.data?.content);
console.log("Stopping client...");
await client.stop();

console.log("Done!");

// Find any open handles with `node --trace-warnings test-sdk.mjs`
