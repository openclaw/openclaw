import { describe, expect, it } from "vitest";
import { CronToolSchema } from "./cron-tool.js";

type SchemaObj = { properties?: Record<string, { properties?: Record<string, unknown> }> };

describe("CronToolSchema", () => {
  it("job.properties is not empty", () => {
    const jobProps = (CronToolSchema as SchemaObj).properties?.job?.properties ?? {};
    expect(Object.keys(jobProps).length).toBeGreaterThan(0);
  });

  it("patch.properties is not empty", () => {
    const patchProps = (CronToolSchema as SchemaObj).properties?.patch?.properties ?? {};
    expect(Object.keys(patchProps).length).toBeGreaterThan(0);
  });
});
