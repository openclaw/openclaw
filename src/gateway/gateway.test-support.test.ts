import { describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  removeGatewayTempHome as removeGatewayTempHomeOwner,
  setupGatewayTempHome as setupGatewayTempHomeOwner,
} from "./gateway-temp-home.test-support.js";
import { removeGatewayTempHome, setupGatewayTempHome } from "./gateway.test-support.js";

describe("setupGatewayTempHome", () => {
  it.skipIf(process.platform === "win32")(
    "creates private state before recursive agent setup under umask 0002",
    async () => {
      expect(setupGatewayTempHome).toBe(setupGatewayTempHomeOwner);
      expect(removeGatewayTempHome).toBe(removeGatewayTempHomeOwner);
      const helperUrl = new URL("./gateway-temp-home.test-support.ts", import.meta.url);
      const result = await runNodeScript(
        (workerArgv) => [
          ...workerArgv(helperUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          `
            import assert from "node:assert/strict";
            import fs from "node:fs/promises";
            import path from "node:path";
            // Creation policy belongs to this child, never the shared Vitest process.
            process.umask(0o002);
            const { setupGatewayTempHome, removeGatewayTempHome } = await import(process.argv[1]);
            const { envSnapshot, tempHome } = await setupGatewayTempHome({
              prefix: "openclaw-gateway-private-",
            });
            try {
              const agentDir = path.join(tempHome, ".openclaw", "agents", "continuation", "agent");
              await fs.mkdir(agentDir, { recursive: true });
              const state = await fs.stat(path.join(tempHome, ".openclaw"));
              assert.equal(state.mode & 0o777, 0o700);
            } finally {
              envSnapshot.restore();
              await removeGatewayTempHome(tempHome);
            }
          `,
          helperUrl.href,
        ],
        { ...process.env },
        10_000,
        { requireProcessTreeExit: true },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
  );

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
