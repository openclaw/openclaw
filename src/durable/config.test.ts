import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import {
  isDurableAuthorityEnabled,
  isDurableObservationEnabled,
  resolveDurableRuntimeMode,
  resolveDurableWorkerClaimTtlMs,
  resolveDurableWorkerPollIntervalMs,
} from "./config.js";

describe("durable runtime config", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("uses normal config for mode and owner-recovery worker settings", () => {
    const config: OpenClawConfig = {
      durable: {
        mode: "authority",
        worker: { pollIntervalMs: 250, claimTtlMs: 20_000 },
      },
    };
    expect(OpenClawSchema.parse(config)).toMatchObject(config);
    setRuntimeConfigSnapshot(config);

    expect(resolveDurableRuntimeMode({})).toBe("authority");
    expect(isDurableAuthorityEnabled({})).toBe(true);
    expect(isDurableObservationEnabled({})).toBe(false);
    expect(resolveDurableWorkerPollIntervalMs({})).toBe(250);
    expect(resolveDurableWorkerClaimTtlMs({})).toBe(20_000);
  });

  it("keeps explicit environment flags as deployment overrides", () => {
    setRuntimeConfigSnapshot({ durable: { mode: "authority" } });

    expect(resolveDurableRuntimeMode({ OPENCLAW_DURABLE_WORKER: "0" })).toBe("authority");
    expect(resolveDurableRuntimeMode({ OPENCLAW_DURABLE_WORKER: "1" })).toBe("authority");
    expect(resolveDurableRuntimeMode({ OPENCLAW_DURABLE_RUNTIME: "1" })).toBe("observe");
    expect(
      resolveDurableRuntimeMode({
        OPENCLAW_DURABLE_RUNTIME: "1",
        OPENCLAW_DURABLE_WORKER: "1",
      }),
    ).toBe("authority");
    expect(resolveDurableRuntimeMode({ OPENCLAW_DURABLE_RUNTIME: "0" })).toBe("off");
  });

  it("rejects invalid durable config values", () => {
    expect(() =>
      OpenClawSchema.parse({ durable: { mode: "enabled", worker: { claimTtlMs: 0 } } }),
    ).toThrow();
  });
});
