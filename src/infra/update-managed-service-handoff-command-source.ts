import { SCHTASKS_TIMEOUT_MS } from "../daemon/schtasks-budget.js";

// Embedded into the sealed handoff script; native effects retain their live lease guard.
export const MANAGED_HANDOFF_COMMAND_SOURCE = String.raw`
function runServiceCommand(command, args, onSpawn, deadline, timeoutCap) {
  if (!hasManagedUpdateLease()) return Promise.resolve({ code: 1, stdout: "", stderr: "" });
  return new Promise((resolve) => {
    const remaining = deadline === undefined ? params.recoveryTimeoutMs : deadline - Date.now();
    if (remaining <= 0) return resolve({ code: 1, stdout: "", stderr: "" });
    const scheduledTask = command === "schtasks.exe";
    const timeoutMs = Math.min(timeoutCap ?? remaining, remaining,
      scheduledTask ? ${SCHTASKS_TIMEOUT_MS} : Infinity);
    const output = { stdout: "", stderr: "" };
    const launchdInspection = command === "launchctl" && args[0] === "print";
    let inspectionOverflow = false;
    const child = spawn(command, args, {
      env: params.serviceManagerEnv,
      stdio: ["ignore", "pipe", "pipe"],
      killSignal: "SIGKILL",
      timeout: timeoutMs,
    });
    for (const stream of ["stdout", "stderr"]) {
      child[stream]?.on("data", (chunk) => {
        // Job parsing needs the header and all root fields; a tail can admit a nested PID.
        if (launchdInspection && stream === "stdout") {
          if (!inspectionOverflow) {
            output.stdout += chunk;
            if (output.stdout.length > 1024 * 1024) {
              output.stdout = "";
              inspectionOverflow = true;
            }
          }
        } else output[stream] = (output[stream] + chunk).slice(-8192);
      });
    }
    child.once("spawn", () => onSpawn?.());
    child.once("error", (error) => {
      output.stderr = String(error);
    });
    child.once("close", (code) => {
      // This private child is killed only by spawn's timeout, not helper cancellation.
      if (scheduledTask && child.killed) {
        const detail = "schtasks " + args[0] + " timed out after " + timeoutMs + "ms";
        appendLog(detail);
        output.stderr = [detail, output.stderr].filter(Boolean).join("\n");
        code = 124;
      }
      if (inspectionOverflow) {
        output.stderr = ["launchctl print exceeded the inspection output limit", output.stderr].filter(Boolean).join("\n");
        code = 1;
      }
      resolve({ code: typeof code === "number" ? code : 1, ...output });
    });
  });
}
`.trim();
