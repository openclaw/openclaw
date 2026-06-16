// Cron protocol schema tests cover runtime validation for cron protocol payloads.
import { describe, expect, it } from "vitest";
import {
  CronJobPatchSchema,
  CronJobStateSchema,
} from "../../packages/gateway-protocol/src/schema.js";

type SchemaLike = {
  properties?: Record<string, unknown>;
  deprecated?: boolean;
  additionalProperties?: boolean;
};

describe("cron protocol schema", () => {
  it("marks the legacy lastStatus alias deprecated", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    const lastStatus = properties.lastStatus as SchemaLike | undefined;
    if (!lastStatus) {
      throw new Error("expected legacy lastStatus schema alias");
    }
    expect(lastStatus.deprecated).toBe(true);
  });

  it("exposes failure-notification delivery state", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(properties.lastFailureNotificationDelivered).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryStatus).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryError).toBeDefined();
  });

  it("exposes the schedule activation timestamp used by restart catch-up", () => {
    // The closed schema rejects unknown properties, so cron.get/list responses
    // carrying scheduleActivatedAtMs must declare it here (#91944).
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(properties.scheduleActivatedAtMs).toBeDefined();
  });

  it("rejects schedule activation timestamps in public state patches", () => {
    const patchProperties = (CronJobPatchSchema as SchemaLike).properties ?? {};
    const stateSchema = patchProperties.state as SchemaLike | undefined;
    expect(stateSchema?.additionalProperties).toBe(false);
    expect(stateSchema?.properties?.scheduleActivatedAtMs).toBeUndefined();
  });
});
