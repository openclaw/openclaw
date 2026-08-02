import { afterEach, describe, expect, it, vi } from "vitest";
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
    vi.unstubAllEnvs();
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

    expect(resolveDurableRuntimeMode()).toBe("authority");
    expect(isDurableAuthorityEnabled()).toBe(true);
    expect(isDurableObservationEnabled()).toBe(false);
    expect(resolveDurableWorkerPollIntervalMs()).toBe(250);
    expect(resolveDurableWorkerClaimTtlMs()).toBe(20_000);
  });

  it("does not expose hidden environment overrides for durable authority", () => {
    setRuntimeConfigSnapshot({ durable: { mode: "authority" } });
    vi.stubEnv("OPENCLAW_DURABLE_RUNTIME", "0");
    vi.stubEnv("OPENCLAW_DURABLE_WORKER", "0");
    vi.stubEnv("OPENCLAW_DURABLE_WORKER_POLL_INTERVAL_MS", "25");
    vi.stubEnv("OPENCLAW_DURABLE_WORKER_CLAIM_TTL_MS", "120");

    expect(resolveDurableRuntimeMode()).toBe("authority");
    expect(resolveDurableWorkerPollIntervalMs()).toBe(1000);
    expect(resolveDurableWorkerClaimTtlMs()).toBe(5 * 60 * 1000);
  });

  it("rejects invalid durable config values", () => {
    expect(() =>
      OpenClawSchema.parse({ durable: { mode: "enabled", worker: { claimTtlMs: 0 } } }),
    ).toThrow();
  });
});
