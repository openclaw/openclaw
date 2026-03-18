import { describe, expect, it } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "../gateway/test-helpers.js";
import { withTempConfig } from "../gateway/test-temp-config.js";

installGatewayTestHooks();

const { resolveGatewayProbeSnapshot } = await import("./status.scan.shared.js");
const { readBestEffortConfig } = await import("../config/config.js");

describe("resolveGatewayProbeSnapshot integration", () => {
  it("keeps local authenticated status probes out of scope-limited mode", async () => {
    const token =
      typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
        ? ((testState.gatewayAuth as { token?: string }).token ?? "")
        : "";
    expect(token).toBeTruthy();

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
          expect(snapshot.gatewayProbe).not.toBeNull();
          expect(snapshot.gatewayProbe?.ok).toBe(true);
          expect(snapshot.gatewayProbe?.error).toBeNull();
          expect(snapshot.gatewayProbe?.presence).not.toBeNull();
        },
      });
    });
  });
});
