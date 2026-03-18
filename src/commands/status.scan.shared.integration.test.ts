import { describe, expect, it } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "../gateway/test-helpers.js";
import { withTempConfig } from "../gateway/test-temp-config.js";

installGatewayTestHooks();

// Load the module under test after the gateway harness installs its hooks.
const { resolveGatewayProbeSnapshot } = await import("./status.scan.shared.js");

describe("resolveGatewayProbeSnapshot integration", () => {
  it("keeps local authenticated status probes out of scope-limited mode", async () => {
    const rawToken = (testState.gatewayAuth as { token?: string } | undefined)?.token;
    expect(rawToken).toBeTruthy();
    const token = rawToken!;

    await withGatewayServer(async ({ port }) => {
      await withTempConfig({
        prefix: "openclaw-status-scan-shared-integration-",
        cfg: {
          gateway: {
            mode: "local",
            bind: "loopback",
            port,
            auth: {
              mode: "token",
              token,
            },
          },
        },
        run: async () => {
          const { readBestEffortConfig } = await import("../config/config.js");
          const cfg = await readBestEffortConfig();
          const snapshot = await resolveGatewayProbeSnapshot({
            cfg,
            opts: {
              all: true,
              timeoutMs: 5_000,
            },
          });

          expect(snapshot.gatewayMode).toBe("local");
          expect(snapshot.gatewayProbeAuth.token).toBe(token);
          expect(snapshot.gatewayProbeAuthWarning).toBeUndefined();
          const gatewayProbe = snapshot.gatewayProbe;
          expect(gatewayProbe).not.toBeNull();
          expect(gatewayProbe!.ok).toBe(true);
          expect(gatewayProbe!.error).toBeNull();
          expect(gatewayProbe!.presence).not.toBeNull();
        },
      });
    });
  });
});
