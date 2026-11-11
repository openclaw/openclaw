import "../../test-utils/prepare-compiled-subprocesses.js";
import { registerGatewayThreadDatabaseProbeTests } from "../../../test/helpers/gateway-thread-database-probe.js";
import { stateLeasePostgresRuntimeEntrypoint } from "../../state/openclaw-state-lease-runtime.test-support.js";

registerGatewayThreadDatabaseProbeTests({
  suiteName: "native plugin lifecycle leases",
  testName:
    "verifies and renews %s ownership on the Gateway thread without admitting unrelated SQL",
  dirPrefix: "native-plugin-lease-",
  entrypoint: stateLeasePostgresRuntimeEntrypoint,
  connectionEnv: "OPENCLAW_TEST_LEASE_PG_CONNECTION",
  failureReason: "Native lease process failed",
  successPrefix: "native lease verification, renewal and refusal passed: ",
});
