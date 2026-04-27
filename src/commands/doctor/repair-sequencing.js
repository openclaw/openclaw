import { sanitizeForLog } from "../../terminal/ansi.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./shared/allowlist-policy-repair.js";
import { maybeRepairBundledPluginLoadPaths } from "./shared/bundled-plugin-load-paths.js";
import { createChannelDoctorEmptyAllowlistPolicyHooks, collectChannelDoctorRepairMutations, } from "./shared/channel-doctor.js";
import { applyDoctorConfigMutation, } from "./shared/config-mutation-state.js";
import { scanEmptyAllowlistPolicyWarnings } from "./shared/empty-allowlist-scan.js";
import { maybeRepairExecSafeBinProfiles } from "./shared/exec-safe-bins.js";
import { maybeRepairLegacyToolsBySenderKeys } from "./shared/legacy-tools-by-sender.js";
import { maybeRepairOpenPolicyAllowFrom } from "./shared/open-policy-allowfrom.js";
import { maybeRepairStalePluginConfig } from "./shared/stale-plugin-config.js";
export async function runDoctorRepairSequence(params) {
    let state = params.state;
    const changeNotes = [];
    const warningNotes = [];
    const env = params.env ?? process.env;
    const sanitizeLines = (lines) => lines.map((line) => sanitizeForLog(line)).join("\n");
    const applyMutation = (mutation) => {
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
    for (const mutation of await collectChannelDoctorRepairMutations({
        cfg: state.candidate,
        doctorFixCommand: params.doctorFixCommand,
        env,
    })) {
        applyMutation(mutation);
    }
    applyMutation(maybeRepairOpenPolicyAllowFrom(state.candidate));
    applyMutation(maybeRepairBundledPluginLoadPaths(state.candidate, env));
    applyMutation(maybeRepairStalePluginConfig(state.candidate, env));
    applyMutation(await maybeRepairAllowlistPolicyAllowFrom(state.candidate));
    const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(state.candidate, {
        doctorFixCommand: params.doctorFixCommand,
        ...createChannelDoctorEmptyAllowlistPolicyHooks({ cfg: state.candidate, env }),
    });
    if (emptyAllowlistWarnings.length > 0) {
        warningNotes.push(sanitizeLines(emptyAllowlistWarnings));
    }
    applyMutation(maybeRepairLegacyToolsBySenderKeys(state.candidate));
    applyMutation(maybeRepairExecSafeBinProfiles(state.candidate));
    return { state, changeNotes, warningNotes };
}
