import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditOptions, SecurityAuditReport } from "./audit.js";
import { audit, hasFinding } from "./audit.test-helpers.js";

describe("security audit deep probe failure", () => {
  it("adds probe_failed warnings for deep probe failure modes", async () => {
    const cfg: OpenClawConfig = { gateway: { mode: "local" } };
    const cases: Array<{
      name: string;
      probeGatewayFn: NonNullable<SecurityAuditOptions["probeGatewayFn"]>;
      assertDeep?: (res: SecurityAuditReport) => void;
    }> = [
      {
        name: "probe returns failed result",
        probeGatewayFn: async () => ({
          ok: false,
          url: "ws://127.0.0.1:18789",
          connectLatencyMs: null,
          error: "connect failed",
          close: null,
          health: null,
          status: null,
          presence: null,
          configSnapshot: null,
        }),
      },
      {
        name: "probe throws",
        probeGatewayFn: async () => {
          throw new Error("probe boom");
        },
        assertDeep: (res) => {
          expect(res.deep?.gateway?.ok).toBe(false);
          expect(res.deep?.gateway?.error).toContain("probe boom");
        },
      },
    ];

    await Promise.all(
      cases.map(async (testCase) => {
        const res = await audit(cfg, {
          deep: true,
          deepTimeoutMs: 50,
          probeGatewayFn: testCase.probeGatewayFn,
        });
        testCase.assertDeep?.(res);
        expect(hasFinding(res, "gateway.probe_failed", "warn"), testCase.name).toBe(true);
      }),
    );
  });
});
