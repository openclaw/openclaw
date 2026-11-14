import "../../test-utils/prepare-compiled-subprocesses.js";
import { registerGatewayThreadDatabaseProbeTests } from "../../../test/helpers/gateway-thread-database-probe.js";
import { agentProcessTestEntrypoints } from "../../agents/process-runtime.test-support.js";

registerGatewayThreadDatabaseProbeTests({
  suiteName: "inline API-key failure bookkeeping on the Gateway thread",
  testName: "records %s inline-key failure without admitting host SQL",
  dirPrefix: "inline-auth-failure-",
  entrypoint: agentProcessTestEntrypoints.inlineAuthFailure,
  connectionEnv: "OPENCLAW_TEST_AUTH_INLINE_PG_CONNECTION",
  failureReason: "Inline API-key failure bookkeeping failed",
  successPrefix: "Inline auth failure persisted on Gateway thread: ",
});
