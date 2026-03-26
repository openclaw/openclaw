import { sanitizeForLog } from "../../terminal/ansi.js";
import { maybeRepairDiscordNumericIds } from "./providers/discord.js";
import {
  collectTelegramEmptyAllowlistExtraWarnings,
  maybeRepairTelegramAllowFromUsernames,
} from "./providers/telegram.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./shared/allowlist-policy-repair.js";
import {
  applyDoctorConfigMutation,
  type DoctorConfigMutationState,
} from "./shared/config-mutation-state.js";
import { scanEmptyAllowlistPolicyWarnings } from "./shared/empty-allowlist-scan.js";
import { maybeRepairExecSafeBinProfiles } from "./shared/exec-safe-bins.js";
import { maybeRepairLegacyToolsBySenderKeys } from "./shared/legacy-tools-by-sender.js";
import { maybeRepairOpenPolicyAllowFrom } from "./shared/open-policy-allowfrom.js";
import { maybeRepairStalePluginConfig } from "./shared/stale-plugin-config.js";

export async function runDoctorRepairSequence(params: {
  state: DoctorConfigMutationState;
  doctorFixCommand: string;
}): Promise<{
  state: DoctorConfigMutationState;
  changeNotes: string[];
  warningNotes: string[];
}> {
  let state = params.state;
  const changeNotes: string[] = [];
  const warningNotes: string[] = [];
  const sanitizeLines = (lines: string[]) => lines.map((line) => sanitizeForLog(line)).join("\n");

  const applyMutation = (mutation: {
    config: DoctorConfigMutationState["candidate"];
    changes: string[];
    warnings?: string[];
  }) => {
    if (mutation.changes.length > 0) {
      changeNotes.push(sanitizeLines(mutation.changes));
      state = applyDoctorConfigMutation({
        state,
        mutation,
        shouldRepair: true,
      });
    }
    if (mutation.warnings && mutation.warnings.length > 0) {
      warningNotes.push(sanitizeLines(mutation.warnings));
    }
  };

  applyMutation(await maybeRepairTelegramAllowFromUsernames(state.candidate));
  applyMutation(maybeRepairDiscordNumericIds(state.candidate));
  applyMutation(maybeRepairOpenPolicyAllowFrom(state.candidate));
  applyMutation(maybeRepairStalePluginConfig(state.candidate, process.env));
  applyMutation(await maybeRepairAllowlistPolicyAllowFrom(state.candidate));

  const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(state.candidate, {
    doctorFixCommand: params.doctorFixCommand,
    extraWarningsForAccount: collectTelegramEmptyAllowlistExtraWarnings,
  });
  if (emptyAllowlistWarnings.length > 0) {
    warningNotes.push(sanitizeLines(emptyAllowlistWarnings));
  }

  applyMutation(maybeRepairLegacyToolsBySenderKeys(state.candidate));
  applyMutation(maybeRepairExecSafeBinProfiles(state.candidate));

  return { state, changeNotes, warningNotes };
}
