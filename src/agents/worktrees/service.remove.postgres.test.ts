import "../../test-utils/prepare-compiled-subprocesses.js";
import { registerGatewayThreadDatabaseProbeTests } from "../../../test/helpers/gateway-thread-database-probe.js";
import { managedWorktreeRemovalEntrypoint } from "./service-gc-runtime.test-support.js";

registerGatewayThreadDatabaseProbeTests({
  suiteName: "managed worktree removal",
  testName: "snapshots and removes a managed worktree on the %s-backed Gateway thread",
  dirPrefix: "worktree-removal-",
  entrypoint: managedWorktreeRemovalEntrypoint,
  connectionEnv: "OPENCLAW_TEST_WORKTREE_REMOVAL_DSN",
  failureReason: "Managed worktree removal failed",
  successPrefix: "Managed worktree removal passed: ",
});
