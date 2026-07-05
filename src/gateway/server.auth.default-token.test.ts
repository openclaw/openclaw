/**
 * Gateway default auth-token tests.
 */
import { describe } from "vitest";
import { registerDefaultAuthTokenSuite } from "./server.auth.default-token.suite.js";
<<<<<<< HEAD
import { installGatewayTestHooks } from "./server.auth.test-helpers.js";
=======
import { installGatewayTestHooks } from "./server.auth.shared.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

installGatewayTestHooks({ scope: "suite" });

describe("gateway server auth/connect", () => {
  registerDefaultAuthTokenSuite();
});
