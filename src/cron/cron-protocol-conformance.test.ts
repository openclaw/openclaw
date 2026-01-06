import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CronPayloadSchema } from "../gateway/protocol/schema.js";

type SchemaLike = {
  anyOf?: Array<{ properties?: Record<string, unknown> }>;
  properties?: Record<string, unknown>;
  const?: unknown;
};

type ProviderSchema = {
  anyOf?: Array<{ const?: unknown }>;
};

function extractCronProviders(schema: SchemaLike): string[] {
  const union = schema.anyOf ?? [];
  const payloadWithProvider = union.find((entry) =>
    Boolean(entry?.properties && "provider" in entry.properties),
  );
  const providerSchema = payloadWithProvider?.properties
    ? (payloadWithProvider.properties.provider as ProviderSchema)
    : undefined;
  const providers = (providerSchema?.anyOf ?? [])
    .map((entry) => entry?.const)
    .filter((value): value is string => typeof value === "string");
  return providers;
}

const UI_FILES = [
  "ui/src/ui/types.ts",
  "ui/src/ui/ui-types.ts",
  "ui/src/ui/views/cron.ts",
];

const SWIFT_FILES = ["apps/macos/Sources/Clawdbot/GatewayConnection.swift"];

describe("cron protocol conformance", () => {
  it("ui + swift include all cron providers from gateway schema", async () => {
    const providers = extractCronProviders(CronPayloadSchema as SchemaLike);
    expect(providers.length).toBeGreaterThan(0);

    const cwd = process.cwd();
    for (const relPath of UI_FILES) {
      const content = await fs.readFile(path.join(cwd, relPath), "utf-8");
      for (const provider of providers) {
        expect(
          content.includes(`"${provider}"`),
          `${relPath} missing ${provider}`,
        ).toBe(true);
      }
    }

    for (const relPath of SWIFT_FILES) {
      const content = await fs.readFile(path.join(cwd, relPath), "utf-8");
      for (const provider of providers) {
        const pattern = new RegExp(`\\bcase\\s+${provider}\\b`);
        expect(
          pattern.test(content),
          `${relPath} missing case ${provider}`,
        ).toBe(true);
      }
    }
  });

  it("cron status shape matches gateway fields in UI + Swift", async () => {
    const cwd = process.cwd();
    const uiTypes = await fs.readFile(
      path.join(cwd, "ui/src/ui/types.ts"),
      "utf-8",
    );
    expect(uiTypes.includes("export type CronStatus")).toBe(true);
    expect(uiTypes.includes("jobs:")).toBe(true);
    expect(uiTypes.includes("jobCount")).toBe(false);

    const swift = await fs.readFile(
      path.join(cwd, "apps/macos/Sources/Clawdbot/GatewayConnection.swift"),
      "utf-8",
    );
    expect(swift.includes("struct CronSchedulerStatus")).toBe(true);
    expect(swift.includes("let jobs:")).toBe(true);
  });
});
