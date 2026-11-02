import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordPluginSdkDeprecatedImport } from "./sdk-deprecated-imports.js";
import { buildPluginSdkDeprecationNotices } from "./sdk-deprecation-notices.js";
import { recordPluginSdkDeprecationUsage } from "./sdk-deprecation-usage.js";

// Notices branch on the real UTC calendar; pin the clock so fixed removeAfter
// fixtures stay deterministic after their dates pass.
function setUtcClock(isoDay: string) {
  vi.setSystemTime(new Date(`${isoDay}T12:00:00Z`));
}

beforeEach(() => {
  vi.useFakeTimers();
  setUtcClock("2026-06-15");
});

afterEach(() => {
  vi.useRealTimers();
});

it("presents recorded members, replacement hints, and their approved final compatibility day", () => {
  recordPluginSdkDeprecationUsage(
    "notice-synthetic",
    "session-store:getSessionEntry",
    "getSessionEntry",
    "getSessionEntryAsync",
    "2026-12-31",
  );
  expect(buildPluginSdkDeprecationNotices("notice-synthetic")).toEqual([
    {
      code: "deprecated-sdk-api",
      severity: "info",
      message:
        "Uses OpenClaw APIs that retire on Dec 31, 2026. It keeps working until then; check for a plugin update.",
      removalDate: "2026-12-31",
      migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate",
      apis: [
        {
          id: "session-store:getSessionEntry",
          displayName: "getSessionEntry",
          replacement: "getSessionEntryAsync",
          removeAfter: "2026-12-31",
        },
      ],
    },
  ]);
  expect(buildPluginSdkDeprecationNotices("notice-unused")).toEqual([]);
});

it("keeps the earliest announced retirement visible alongside undated APIs", () => {
  recordPluginSdkDeprecationUsage("notice-mixed", "older", "older", "current");
  recordPluginSdkDeprecationUsage("notice-mixed", "later", "later", "current", "2027-03-31");
  recordPluginSdkDeprecationUsage("notice-mixed", "sooner", "sooner", "current", "2026-12-31");
  expect(buildPluginSdkDeprecationNotices("notice-mixed")).toMatchObject([
    {
      removalDate: "2026-12-31",
      message: expect.stringContaining("retire on Dec 31, 2026"),
    },
  ]);
});

it("states an elapsed migration date without claiming the APIs retired", () => {
  recordPluginSdkDeprecationUsage(
    "notice-past",
    "session-store:getSessionEntry",
    "getSessionEntry",
    "getSessionEntryAsync",
    "2020-01-01",
  );
  expect(buildPluginSdkDeprecationNotices("notice-past")).toEqual([
    {
      code: "deprecated-sdk-api",
      severity: "info",
      message:
        "Uses OpenClaw APIs whose migration date passed on Jan 1, 2020. The APIs remain available; plugin authors should migrate. See the migration guide.",
      removalDate: "2020-01-01",
      migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate",
      apis: [
        {
          id: "session-store:getSessionEntry",
          displayName: "getSessionEntry",
          replacement: "getSessionEntryAsync",
          removeAfter: "2020-01-01",
        },
      ],
    },
  ]);
});

it("keeps future-tense copy on the final compatibility day and switches the next UTC day", () => {
  recordPluginSdkDeprecationUsage(
    "notice-boundary",
    "session-store:getSessionEntry",
    "getSessionEntry",
    "getSessionEntryAsync",
    "2026-12-31",
  );
  setUtcClock("2026-12-31");
  expect(buildPluginSdkDeprecationNotices("notice-boundary")[0]?.message).toBe(
    "Uses OpenClaw APIs that retire on Dec 31, 2026. It keeps working until then; check for a plugin update.",
  );
  setUtcClock("2027-01-01");
  expect(buildPluginSdkDeprecationNotices("notice-boundary")[0]?.message).toBe(
    "Uses OpenClaw APIs whose migration date passed on Dec 31, 2026. The APIs remain available; plugin authors should migrate. See the migration guide.",
  );
});

it("uses registry metadata only for deprecated subpaths and does not invent an undated deadline", () => {
  recordPluginSdkDeprecatedImport("notice-subpaths", "openclaw/plugin-sdk/session-store-runtime");
  expect(buildPluginSdkDeprecationNotices("notice-subpaths")).toEqual([]);
  recordPluginSdkDeprecatedImport("notice-subpaths", "@openclaw/plugin-sdk/tool-plugin.js");
  recordPluginSdkDeprecatedImport("notice-subpaths", "openclaw/plugin-sdk/tool-plugin");
  expect(buildPluginSdkDeprecationNotices("notice-subpaths")).toEqual([
    {
      code: "deprecated-sdk-api",
      severity: "info",
      message: "Uses older OpenClaw APIs. It keeps working for now; check for a plugin update.",
      migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate",
      apis: [
        {
          id: "openclaw/plugin-sdk/tool-plugin",
          displayName: "openclaw/plugin-sdk/tool-plugin",
          replacement: expect.stringContaining("nonexecuting static metadata replacement"),
        },
      ],
    },
  ]);
});
