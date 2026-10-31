import "../test-utils/prepare-compiled-subprocesses.js";
import { registerGatewayThreadDatabaseProbeTests } from "../../test/helpers/gateway-thread-database-probe.js";
import { clientVoiceEntryRuntimeEntrypoint } from "./client-voice-session-runtime.test-support.js";

registerGatewayThreadDatabaseProbeTests({
  suiteName: "Talk entry initialization on the Gateway thread",
  testName: "creates and resumes canonical voice entries on %s without admitting host SQL",
  dirPrefix: "talk-entry-gateway-",
  entrypoint: clientVoiceEntryRuntimeEntrypoint,
  connectionEnv: "OPENCLAW_TEST_TALK_ENTRY_PG_CONNECTION",
  failureReason: "Talk entry initialization failed",
  successPrefix: "Talk entry initialization passed on the Gateway thread: ",
});
