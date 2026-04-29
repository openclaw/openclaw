import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

/**
 * Regression tests for #74577 — the `BrowserTabCleanupConfig` type, the
 * runtime resolver `resolveBrowserTabCleanupConfig`, and the
 * `browser.tabCleanup.*` help/label entries all existed, but the zod
 * schema's `.strict()` browser object did not declare `tabCleanup`. As a
 * result every operator who tried to override the documented defaults
 * (`enabled=true`, `idleMinutes=120`, `maxTabsPerSession=8`,
 * `sweepMinutes=5`) saw their config rolled back at startup with
 * `Gateway aborted: config is invalid. browser: Unrecognized key: "tabCleanup"`.
 *
 * These tests pin the schema shape so the rollback regression cannot
 * silently come back.
 */

describe("OpenClawSchema browser.tabCleanup validation", () => {
  it("accepts the full documented shape", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: {
            enabled: true,
            idleMinutes: 10,
            sweepMinutes: 5,
            maxTabsPerSession: 10,
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts the documented zero sentinel for idleMinutes (disables idle cleanup)", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { idleMinutes: 0 },
        },
      }),
    ).not.toThrow();
  });

  it("accepts the documented zero sentinel for maxTabsPerSession (disables the cap)", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { maxTabsPerSession: 0 },
        },
      }),
    ).not.toThrow();
  });

  it("accepts a partial override (omitted keys fall back to defaults at runtime)", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { enabled: false },
        },
      }),
    ).not.toThrow();
  });

  it("rejects unknown keys under tabCleanup so typos surface immediately", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { idleMins: 10 },
        },
      }),
    ).toThrow(/idleMins|tabCleanup|Unrecognized/i);
  });

  it("rejects negative idleMinutes", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { idleMinutes: -1 },
        },
      }),
    ).toThrow();
  });

  it("rejects non-integer idleMinutes", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { idleMinutes: 1.5 },
        },
      }),
    ).toThrow();
  });

  it("rejects sweepMinutes <= 0 (would either spin or never fire downstream)", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { sweepMinutes: 0 },
        },
      }),
    ).toThrow();
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { sweepMinutes: -1 },
        },
      }),
    ).toThrow();
  });

  it("does not regress the strict browser schema for the surrounding fields", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          enabled: true,
          tabCleanup: { enabled: true },
          headless: false,
        },
      }),
    ).not.toThrow();
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          tabCleanup: { enabled: true },
          unknownBrowserField: 1,
        },
      }),
    ).toThrow(/unknownBrowserField|Unrecognized/i);
  });
});
