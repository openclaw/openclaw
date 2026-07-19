import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import {
  isDurableAuthorityEnabled,
  isDurableObservationEnabled,
  resolveDurableInputFullMaxChars,
  resolveDurableInputPreviewChars,
  resolveDurableInputTextPolicy,
  resolveDurableRuntimeMode,
  resolveDurableWorkerClaimTtlMs,
  resolveDurableWorkerMaxConcurrency,
  resolveDurableWorkerPollIntervalMs,
} from "./config.js";

describe("durable runtime config", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("uses normal config for mode, worker, and input retention", () => {
    const config: OpenClawConfig = {
      durable: {
        mode: "authority",
        worker: { pollIntervalMs: 250, claimTtlMs: 20_000, maxConcurrency: 3 },
        input: { previewChars: 120, text: "full", fullMaxChars: 4_096 },
      },
    };
    expect(OpenClawSchema.parse(config)).toMatchObject(config);
    setRuntimeConfigSnapshot(config);

    expect(resolveDurableRuntimeMode({})).toBe("authority");
    expect(isDurableAuthorityEnabled({})).toBe(true);
    expect(isDurableObservationEnabled({})).toBe(false);
    expect(resolveDurableWorkerPollIntervalMs({})).toBe(250);
    expect(resolveDurableWorkerClaimTtlMs({})).toBe(20_000);
    expect(resolveDurableWorkerMaxConcurrency({})).toBe(3);
    expect(resolveDurableInputPreviewChars({})).toBe(120);
    expect(resolveDurableInputTextPolicy({})).toBe("full");
    expect(resolveDurableInputFullMaxChars({})).toBe(4_096);
  });

  it("keeps explicit environment flags as deployment overrides", () => {
    setRuntimeConfigSnapshot({ durable: { mode: "authority" } });

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
      OpenClawSchema.parse({ durable: { mode: "enabled", worker: { maxConcurrency: 0 } } }),
    ).toThrow();
  });
});
