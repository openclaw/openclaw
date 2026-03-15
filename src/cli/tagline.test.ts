import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TAGLINE, pickTagline, resolveScriptTagline } from "./tagline.js";

describe("pickTagline", () => {
  it("returns empty string when mode is off", () => {
    expect(pickTagline({ mode: "off" })).toBe("");
  });

  it("returns default tagline when mode is default", () => {
    expect(pickTagline({ mode: "default" })).toBe(DEFAULT_TAGLINE);
  });

  it("keeps OPENCLAW_TAGLINE_INDEX behavior in random mode", () => {
    const value = pickTagline({
      mode: "random",
      env: { OPENCLAW_TAGLINE_INDEX: "0" } as NodeJS.ProcessEnv,
    });
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toBe(DEFAULT_TAGLINE);
  });

  it("returns pre-resolved tagline when mode is script", () => {
    expect(pickTagline({ mode: "script", resolvedTagline: "moo" })).toBe("moo");
  });

  it("returns empty string when mode is script and no resolvedTagline", () => {
    expect(pickTagline({ mode: "script" })).toBe("");
  });
});

describe("resolveScriptTagline", () => {
  it("resolves a string default export", async () => {
    const file = join(tmpdir(), `tagline-str-${Date.now()}.mjs`);
    writeFileSync(file, 'export default "hello from string";');
    expect(await resolveScriptTagline(file)).toBe("hello from string");
  });

  it("resolves a sync function default export", async () => {
    const file = join(tmpdir(), `tagline-fn-${Date.now()}.mjs`);
    writeFileSync(file, 'export default function() { return "hello from fn"; }');
    expect(await resolveScriptTagline(file)).toBe("hello from fn");
  });

  it("resolves an async function default export", async () => {
    const file = join(tmpdir(), `tagline-async-${Date.now()}.mjs`);
    writeFileSync(file, 'export default async function() { return "hello from async"; }');
    expect(await resolveScriptTagline(file)).toBe("hello from async");
  });

  it("returns empty string for an unrecognised export type", async () => {
    const file = join(tmpdir(), `tagline-num-${Date.now()}.mjs`);
    writeFileSync(file, "export default 42;");
    expect(await resolveScriptTagline(file)).toBe("");
  });
});
