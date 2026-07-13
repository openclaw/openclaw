import { setTimeout as delay } from "node:timers/promises";
import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { runExec } from "../process/exec.js";
import { toErrorObject } from "./errors.js";

const TAILSCALE_STATUS_ATTEMPTS = 3;
const TAILSCALE_STATUS_RETRY_DELAY_MS = 500;

function isTransientTailscaleStatusError(error: unknown): boolean {
  const record = readRecord(error);
  // runExec's timeout terminates the child with SIGTERM. During startup an unavailable
  // daemon socket can hang until this boundary instead of returning a connection message.
  const timedOut = record?.killed === true && record.signal === "SIGTERM";
  const detail = [
    error instanceof Error ? error.message : undefined,
    typeof record?.stderr === "string" ? record.stderr : undefined,
    typeof record?.stdout === "string" ? record.stdout : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();

  return (
    timedOut ||
    detail.includes("failed to connect to local tailscale") ||
    detail.includes("connection refused") ||
    detail.includes("503 service unavailable: no backend")
  );
}

export async function readTailscaleStatusJson(
  candidate: string,
  exec: typeof runExec,
  parse: (stdout: string) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= TAILSCALE_STATUS_ATTEMPTS; attempt += 1) {
    let stdout: string;
    try {
      ({ stdout } = await exec(candidate, ["status", "--json"], {
        timeoutMs: 5000,
        maxBuffer: 400_000,
      }));
    } catch (error) {
      if (!isTransientTailscaleStatusError(error) || attempt === TAILSCALE_STATUS_ATTEMPTS) {
        throw toErrorObject(error, "Non-Error thrown");
      }
      // Retry the same detected binary so fallback cannot switch installations while the
      // daemon becomes ready.
      await delay(TAILSCALE_STATUS_RETRY_DELAY_MS);
      continue;
    }
    return stdout ? parse(stdout) : {};
  }
  throw new Error("Tailscale status retry loop exhausted");
}
