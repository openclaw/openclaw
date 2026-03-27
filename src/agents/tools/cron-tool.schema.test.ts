import { describe, expect, it } from "vitest";
import { CronToolSchema } from "./cron-tool.js";

/** Walk a TypeBox schema by dot-separated property path and return sorted keys. */
function keysAt(schema: Record<string, unknown>, path: string): string[] {
  let cursor: Record<string, unknown> | undefined = schema;
  for (const segment of path.split(".")) {
    const props = cursor?.["properties"] as Record<string, Record<string, unknown>> | undefined;
    cursor = props?.[segment];
  }
  const leaf = cursor?.["properties"] as Record<string, unknown> | undefined;
  return leaf ? Object.keys(leaf).toSorted() : [];
}

describe("CronToolSchema", () => {
  // Regression: models like GPT-5.4 rely on these fields to populate job/patch.
  // If a field is removed from this list the test must be updated intentionally.

  it("job exposes the expected top-level fields", () => {
    expect(keysAt(CronToolSchema as Record<string, unknown>, "job")).toEqual(
      [
        "agentId",
        "deleteAfterRun",
        "delivery",
        "description",
        "enabled",
        "failureAlert",
        "name",
        "payload",
        "schedule",
        "sessionKey",
        "sessionTarget",
        "wakeMode",
      ].toSorted(),
    );
  });

  it("patch exposes the expected top-level fields", () => {
    expect(keysAt(CronToolSchema as Record<string, unknown>, "patch")).toEqual(
      [
        "agentId",
        "deleteAfterRun",
        "delivery",
        "description",
        "enabled",
        "failureAlert",
        "name",
        "payload",
        "schedule",
        "sessionKey",
        "sessionTarget",
        "wakeMode",
      ].toSorted(),
    );
  });

  it("job.schedule exposes kind, at, everyMs, anchorMs, expr, tz, staggerMs", () => {
    expect(keysAt(CronToolSchema as Record<string, unknown>, "job.schedule")).toEqual(
      ["anchorMs", "at", "everyMs", "expr", "kind", "staggerMs", "tz"].toSorted(),
    );
  });

  it("job.delivery exposes mode, channel, to, bestEffort, accountId, failureDestination", () => {
    expect(keysAt(CronToolSchema as Record<string, unknown>, "job.delivery")).toEqual(
      ["accountId", "bestEffort", "channel", "failureDestination", "mode", "to"].toSorted(),
    );
  });

  it("job.payload exposes kind, text, message, model, thinking and extras", () => {
    expect(keysAt(CronToolSchema as Record<string, unknown>, "job.payload")).toEqual(
      [
        "allowUnsafeExternalContent",
        "fallbacks",
        "kind",
        "lightContext",
        "message",
        "model",
        "text",
        "thinking",
        "timeoutSeconds",
      ].toSorted(),
    );
  });

  it("job.failureAlert exposes after, channel, to, cooldownMs, mode, accountId", () => {
    expect(keysAt(CronToolSchema as Record<string, unknown>, "job.failureAlert")).toEqual(
      ["accountId", "after", "channel", "cooldownMs", "mode", "to"].toSorted(),
    );
  });
});
