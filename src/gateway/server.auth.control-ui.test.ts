/**
 * Gateway Control UI auth pairing tests.
 */
import { describe } from "vitest";
import { registerControlUiAndPairingSuite } from "./server.auth.control-ui.suite.js";
<<<<<<< HEAD
import { installGatewayTestHooks } from "./server.auth.test-helpers.js";
=======
import { installGatewayTestHooks } from "./server.auth.shared.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

installGatewayTestHooks({ scope: "suite" });

await Promise.all([
  import("./server.js"),
  import("../infra/device-bootstrap.js"),
  import("../infra/device-identity.js"),
  import("../infra/device-pairing.js"),
]);

describe("gateway server auth/connect", () => {
  registerControlUiAndPairingSuite();
});
