import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
export async function maybeRunDoctorStartupChannelMaintenance(params) {
    if (!params.shouldRepair) {
        return;
    }
    await runChannelPluginStartupMaintenance({
        cfg: params.cfg,
        env: params.env ?? process.env,
        log: {
            info: (message) => params.runtime.log(message),
            warn: (message) => params.runtime.error(message),
        },
        trigger: "doctor-fix",
        logPrefix: "doctor",
    });
}
