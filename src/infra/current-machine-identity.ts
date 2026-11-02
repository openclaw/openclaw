import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

export const PROCESS_MACHINE_IDENTITY_KEY = "openclaw.processMachineIdentity";

/** Machine identity cannot change within this process; retain failed probes too. */
export function readProcessMachineIdentity(): string | null {
  // SAFETY: Only this owner publishes the fact; new workers inherit its structured clone.
  let machineIdentity = getEnvironmentData(PROCESS_MACHINE_IDENTITY_KEY) as
    | { platform: NodeJS.Platform; value: string | null }
    | undefined;
  if (machineIdentity?.platform !== process.platform) {
    machineIdentity = { platform: process.platform, value: probeMachineIdentity() };
    setEnvironmentData(PROCESS_MACHINE_IDENTITY_KEY, machineIdentity);
  }
  return machineIdentity.value;
}

function probeMachineIdentity(): string | null {
  try {
    let identity: string | undefined;
    if (process.platform === "linux") {
      const value = readFileSync("/etc/machine-id", "utf8").trim();
      if (/^[a-f0-9]{32}$/u.test(value)) {
        identity = value;
      }
    } else if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const matches = [...(result.stdout ?? "").matchAll(/"IOPlatformUUID"\s*=\s*"([^"]+)"/gu)];
      const value = matches.length === 1 ? matches[0]?.[1]?.toLowerCase() : undefined;
      if (
        !result.error &&
        result.status === 0 &&
        value &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
      ) {
        identity = value;
      }
    }
    if (!identity || /^0+$/u.test(identity.replaceAll("-", ""))) {
      return null;
    }
    // OS machine identifiers are confidential; retain only this purpose-specific digest.
    return createHmac("sha256", "openclaw:state-lease-process-owner:machine:v1")
      .update(`${process.platform}\0${identity}`)
      .digest("hex");
  } catch {
    return null;
  }
}
