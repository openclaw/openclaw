import { expect, it } from "vitest";
import { recordPluginSdkDeprecatedImport } from "./sdk-deprecated-imports.js";
import { buildPluginSdkDeprecationNotices } from "./sdk-deprecation-notices.js";
import { recordPluginSdkDeprecationUsage } from "./sdk-deprecation-usage.js";

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
