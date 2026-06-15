// Cron protocol schema tests cover runtime validation for cron protocol payloads.
import { describe, expect, it } from "vitest";
import { CronJobSchema, CronJobStateSchema } from "../../packages/gateway-protocol/src/schema.js";

type SchemaLike = {
  properties?: Record<string, unknown>;
  deprecated?: boolean;
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

  it("exposes cron payload audit metadata on listed jobs", () => {
    const properties = (CronJobSchema as SchemaLike).properties ?? {};
    const audit = properties.audit as SchemaLike | undefined;

    expect(audit).toBeDefined();
    expect(audit?.properties).toMatchObject({
      executionKind: expect.any(Object),
      deterministic: expect.any(Object),
      warnings: expect.any(Object),
    });
  });
});
