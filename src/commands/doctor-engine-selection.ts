import { note } from "../../packages/terminal-core/src/note.js";
import { hasFlag } from "../cli/argv.js";
import { isDoctorMachineOutput } from "../cli/doctor-output-mode.js";
import { formatInvalidConfigDetails } from "../config/io.invalid-config.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { showDoctorIntro, showDoctorOutro } from "../flows/doctor-health-startup.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { prepareDoctorConfigRecovery } from "./doctor-config-preflight-legacy-config.js";
import { sanitizeDoctorNote } from "./doctor/emit-notes.js";

/** Recovery may repair file bytes; an unresolved target must never reach stateful Doctor. */
export async function prepareDoctorEngineSelection(params: {
  argv: string[];
  snapshot: ConfigFileSnapshot;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
}): Promise<ConfigFileSnapshot> {
  const repaired = await prepareDoctorConfigRecovery({
    enabled:
      !hasFlag(params.argv, "--lint") &&
      !hasFlag(params.argv, "--json") &&
      ["--fix", "--repair", "--yes"].some((flag) => hasFlag(params.argv, flag)),
    databaseAccess: "none",
    stateMigrationsRequested: false,
    snapshotRead: { snapshot: params.snapshot },
    planRepair: async () => null,
    readSnapshot: async () => ({ snapshot: await params.readSnapshot() }),
  });
  return repaired.snapshotRead.snapshot;
}

/** Report uninspected storage truthfully, without entering bootstrap, maintenance or plugins. */
export function reportDoctorUnresolvedEngine(
  snapshot: ConfigFileSnapshot,
  argv: string[],
  error?: unknown,
): void {
  const unparseable = snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID");
  const message = unparseable
    ? "unknown: config could not be parsed; fix config (or run `openclaw doctor --fix`), then rerun"
    : "unknown: database target could not be resolved; fix database settings or credentials, then rerun";
  const sections = ["Shared state", "Agent state", "Sessions", "Credentials", "Cron"];
  const details = sanitizeDoctorNote(
    [formatInvalidConfigDetails(snapshot.issues), error ? formatErrorMessage(error) : ""]
      .filter(Boolean)
      .join("\n"),
  );
  const nextStep = unparseable
    ? "Run `openclaw config validate` to inspect the parse error."
    : "Fix database settings or supply the referenced credentials, then rerun `openclaw doctor`.";
  if (isDoctorMachineOutput({ argv, stdoutIsTTY: process.stdout.isTTY })) {
    writeRuntimeJson(defaultRuntime, {
      status: "unknown",
      configPath: snapshot.path,
      details,
      databases: sections.map((section) => ({ section, status: "unknown", message })),
      nextStep,
    });
    return;
  }
  showDoctorIntro("OpenClaw doctor");
  note(
    [
      unparseable
        ? "Config invalid; doctor will run with best-effort config."
        : "Config recovered; the database target remains unresolved.",
      snapshot.path,
      details,
      nextStep,
    ].join("\n"),
    "Config",
  );
  for (const section of sections) {
    note(message, section);
  }
  showDoctorOutro("Doctor complete. Database checks remain unknown.");
}
