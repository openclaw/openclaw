import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { MarkdownConfigSchema } from "./zod-schema.core.js";
import { OpenClawSchema } from "./zod-schema.js";
import { GroupChatSchema } from "./zod-schema.messages.js";

describe("config schema regressions", () => {
  it("accepts historyLimit: 0", () => {
    expect(GroupChatSchema.unwrap().safeParse({ historyLimit: 0 }).success).toBe(true);
  });

  it("accepts markdown table block mode", () => {
    expect(MarkdownConfigSchema.parse({ tables: "block" })).toEqual({ tables: "block" });
  });

  it("accepts valid cron.sessionRetention durations", () => {
    expect(OpenClawSchema.safeParse({ cron: { sessionRetention: "1h30m" } }).success).toBe(true);
  });

  it("leaves skipMissedJobs unset when omitted", () => {
    expect(OpenClawSchema.parse({ cron: {} }).cron?.skipMissedJobs).toBeUndefined();
  });

  it("rejects invalid cron.sessionRetention durations", () => {
    expect(() => OpenClawSchema.parse({ cron: { sessionRetention: "abc" } })).toThrow(
      /sessionRetention|duration/i,
    );
  });

  it("round-trips desktop host config and rejects unsafe or unknown fields", () => {
    const host = { enabled: true, managed: true, port: 5901, passwordFile: "/run/vnc/passwd" };
    expect(OpenClawSchema.parse({ desktop: { host } }).desktop).toStrictEqual({ host });
    expect(
      OpenClawSchema.safeParse({ desktop: { host: { enabled: true, port: 0 } } }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({ desktop: { host: { enabled: true, passwordFile: "relative" } } })
        .success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({ desktop: { host: { enabled: true, manageServer: true } } })
        .success,
    ).toBe(false);
  });

  it("round-trips the Claws Labs visibility setting", () => {
    for (const claws of [true, false]) {
      expect(
        OpenClawSchema.parse({ gateway: { controlUi: { experimental: { claws } } } }).gateway
          ?.controlUi?.experimental?.claws,
      ).toBe(claws);
    }
  });

  it("projects schema-owned field documentation into the public schema and UI hints", () => {
    const response = computeBaseConfigSchemaResponse({ generatedAt: "desktop-metadata" });
    expect(response.schema).toHaveProperty(
      ["properties", "desktop", "properties", "host", "properties", "passwordFile", "title"],
      "Local VNC Password File",
    );
    expect(response.uiHints["desktop.host.passwordFile"]).toMatchObject({
      label: "Local VNC Password File",
      help: "Absolute path to the VNC password file. Omit on macOS to enter account credentials when opening the desktop viewer.",
    });
    expect(response.uiHints["gateway.controlUi.experimental.claws"]).toMatchObject({
      label: "Claws",
      help: expect.stringContaining("default: false"),
    });
  });
});
