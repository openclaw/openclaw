import { runCommandWithTimeout } from "../process/exec.js";
import { trimLogTail } from "./restart-sentinel.js";
import { resolveStableNodePath } from "./stable-node-path.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_SUMMARY_CHARS = 600;

export async function runDoctorNonInteractiveSummary(
  params: {
    cwd?: string;
    entry?: string;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const entry = params.entry?.trim();
  if (!entry) {
    return null;
  }
  try {
    const nodePath = await resolveStableNodePath(process.execPath);
    const res = await runCommandWithTimeout([nodePath, entry, "doctor", "--non-interactive"], {
      cwd: params.cwd,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: { ...process.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
    });
    const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    if (!combined) {
      return res.code === 0 ? "no issues reported" : `doctor exited ${res.code ?? "unknown"}`;
    }
    const singleLine = combined
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(" | ");
    return trimLogTail(singleLine, MAX_SUMMARY_CHARS);
  } catch (err) {
    return `doctor failed: ${String(err)}`;
  }
}
