import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { removeGatewayTempHome, setupGatewayTempHome } from "./gateway.test-support.js";

describe("setupGatewayTempHome", () => {
  it.each([
    { prior: undefined, minimalGateway: true },
    { prior: "1", minimalGateway: false },
  ])(
    "restores minimal mode $prior after minimalGateway=$minimalGateway",
    async ({ prior, minimalGateway }) => {
      await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: prior }, async () => {
        const { envSnapshot, tempHome } = await setupGatewayTempHome({
          prefix: "openclaw-gateway-env-",
          minimalGateway,
        });
        try {
          envSnapshot.restore();
          // Assert before withEnvAsync or global cleanup can restore the fixture's state.
          expect(process.env.OPENCLAW_TEST_MINIMAL_GATEWAY).toBe(prior);
        } finally {
          await removeGatewayTempHome(tempHome);
        }
      });
    },
  );
});
