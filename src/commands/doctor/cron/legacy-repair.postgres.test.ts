import "../../../test-utils/prepare-compiled-subprocesses.js";
import { registerGatewayThreadDatabaseProbeTests } from "../../../../test/helpers/gateway-thread-database-probe.js";
import { cronOwnerInspectionPostgresRuntimeEntrypoint } from "../../../state/openclaw-state-lease-runtime.test-support.js";

registerGatewayThreadDatabaseProbeTests({
  suiteName: "legacy cron owner inspection",
  testName:
    "reads %s cron owners for a roster write on the Gateway thread without admitting unrelated SQL",
  dirPrefix: "cron-owner-inspection-",
  entrypoint: cronOwnerInspectionPostgresRuntimeEntrypoint,
  connectionEnv: "OPENCLAW_TEST_CRON_OWNER_PG_CONNECTION",
  failureReason: "Cron owner inspection process failed",
  successPrefix: "cron owner inspection passed on the Gateway thread: ",
});
