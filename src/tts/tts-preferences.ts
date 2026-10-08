import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";

export type PreparedTtsPreferences = Readonly<{ machinePrefsPath?: string }>;

/** Carry the machine-owned path through one turn; preference-file contents stay fresh. */
export async function prepareTtsPreferences(): Promise<PreparedTtsPreferences> {
  const reply = await executeExistingOpenClawStateRead({}, { type: "tts.prefsPath" });
  if (!reply) {
    return {};
  }
  if (!reply.ok || reply.type !== "tts.prefsPath") {
    throw new Error("Unexpected TTS preference-path read result");
  }
  const value: unknown = reply.row ? JSON.parse(reply.row.value_json) : undefined;
  if (value != null && typeof value !== "string") {
    throw new Error("Invalid TTS preference path: expected a string");
  }
  return { machinePrefsPath: value ?? undefined };
}
