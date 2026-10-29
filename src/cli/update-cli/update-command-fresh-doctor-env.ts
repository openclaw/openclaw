import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_POST_CORE_CONVERGENCE_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { withUpdateEnv } from "./update-command-service-env.js";

export async function withPrePluginUpdateDoctorEnv<T>(run: () => Promise<T>): Promise<T> {
  return await withUpdateEnv(
    {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
      [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      [UPDATE_POST_CORE_CONVERGENCE_ENV]: undefined,
    },
    run,
  );
}
