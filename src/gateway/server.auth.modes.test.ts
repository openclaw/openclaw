/**
 * Gateway auth mode matrix tests.
 */
import { describe } from "vitest";
import { registerAuthModesSuite } from "./server.auth.modes.suite.js";
<<<<<<< HEAD
import { installGatewayTestHooks } from "./server.auth.test-helpers.js";
=======
import { installGatewayTestHooks } from "./server.auth.shared.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

installGatewayTestHooks({ scope: "suite" });

describe("gateway server auth/connect", () => {
  registerAuthModesSuite();
});
