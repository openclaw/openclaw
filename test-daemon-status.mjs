import { isDaemonRunning, readDaemonStatus } from "./src/agents/evo-daemon.js";

async function main() {
  console.log("Checking daemon running...");
  try {
    const running = await isDaemonRunning();
    console.log("Running:", running);
  } catch (err) {
    console.error("Running check failed:", err);
  }

  console.log("Checking daemon status...");
  try {
    const status = await readDaemonStatus();
    console.log("Status:", status);
  } catch (err) {
    console.error("Status check failed:", err);
  }
}

main()
  .then(() => console.log("Done"))
  .catch(console.error);
