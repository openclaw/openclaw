import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DARWIN_SYSTEM_PROBE_TIMEOUT_MS } from "./os-summary.js";

const models = new Map<NodeJS.Platform, string | undefined>();

export function resolveMachineModelIdentifier(platform = os.platform()): string | undefined {
  // Hardware is process-stable; cache missing results too so reconnects never reprobe.
  if (models.has(platform)) {
    return models.get(platform);
  }
  let model: string | undefined;
  if (platform === "darwin") {
    const res = spawnSync("sysctl", ["-n", "hw.model"], {
      encoding: "utf-8",
      timeout: DARWIN_SYSTEM_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    model = normalizeOptionalString(res.stdout);
  } else if (platform === "linux") {
    for (const file of ["/sys/devices/virtual/dmi/id/product_name", "/proc/device-tree/model"]) {
      try {
        const value = readFileSync(file, "utf-8");
        model = normalizeOptionalString(value.trim().replace(/\0+$/, ""));
        if (model) {
          model = truncateUtf16Safe(model, 64);
          break;
        }
      } catch {
        // DMI is absent on many ARM hosts; device-tree is absent on many x86 hosts.
      }
    }
  }
  models.set(platform, model);
  return model;
}
