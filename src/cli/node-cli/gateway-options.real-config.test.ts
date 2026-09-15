// Real proof for PR 145074: blank --host rejection preserves fresh-state and
// upgrade behavior. Uses the REAL resolver + REAL SQLite node-host config via
// withOpenClawTestState (real isolated state dir, no mocks).
import { describe, expect, it } from "vitest";
import { configureNodeHost, loadNodeHostConfig } from "../../node-host/config.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveNodeGatewayOptions } from "./gateway-options.js";

describe("node gateway options (real config)", () => {
  it(
    "rejects a blank --host on both fresh and saved state without changing fallback behavior",
    { timeout: 60_000 },
    async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-node-host-proof-" },
        async () => {
          // withOpenClawTestState has applied OPENCLAW_STATE_DIR to process.env.

          // Fresh state: no saved node-host config -> baseline loopback.
          const freshConfig = await loadNodeHostConfig();
          expect(freshConfig).toBeNull();
          const fresh = resolveNodeGatewayOptions({}, freshConfig);
          expect(fresh.host).toBe("127.0.0.1");
          expect(fresh.port).toBe(18789);

          // Upgrade state: save a real node-host config pointing at 10.0.0.2.
          await configureNodeHost({
            nodeId: "node-proof",
            fallbackDisplayName: "proof node",
            gateway: { host: "10.0.0.2", port: 19001, tls: true },
          });
          const savedConfig = await loadNodeHostConfig();
          expect(savedConfig?.gateway).toMatchObject({
            host: "10.0.0.2",
            port: 19001,
            tls: true,
          });
          const upgrade = resolveNodeGatewayOptions({}, savedConfig);
          expect(upgrade.host).toBe("10.0.0.2");
          expect(upgrade.port).toBe(19001);

          // Blank --host is rejected on both fresh and saved state.
          expect(() => resolveNodeGatewayOptions({ host: " " }, freshConfig)).toThrow(
            "--host must not be blank",
          );
          expect(() => resolveNodeGatewayOptions({ host: "" }, savedConfig)).toThrow(
            "--host must not be blank",
          );
          expect(() => resolveNodeGatewayOptions({ host: "   " }, savedConfig)).toThrow(
            "--host must not be blank",
          );

          // Omitted --host keeps selecting the saved endpoint (upgrade preserved).
          expect(resolveNodeGatewayOptions({}, savedConfig).host).toBe("10.0.0.2");
        },
      );
    },
  );
});
