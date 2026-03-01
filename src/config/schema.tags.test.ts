import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "./schema.js";
import { applyDerivedTags, CONFIG_TAGS, deriveTagsForPath } from "./schema.tags.js";

describe("config schema tags", () => {
  it("derives security/auth tags for credential paths", () => {
    const tags = deriveTagsForPath("gateway.auth.token");
    expect(tags).toContain("security");
    expect(tags).toContain("auth");
  });

  it("derives tools/performance tags for web fetch timeout paths", () => {
    const tags = deriveTagsForPath("tools.web.fetch.timeoutSeconds");
    expect(tags).toContain("tools");
    expect(tags).toContain("performance");
  });

  it("keeps tags in the allowed taxonomy", () => {
    const withTags = applyDerivedTags({
      "gateway.auth.token": {},
      "tools.web.fetch.timeoutSeconds": {},
      "channels.slack.accounts.*.token": {},
    });
    const allowed = new Set<string>(CONFIG_TAGS);
    for (const hint of Object.values(withTags)) {
      for (const tag of hint.tags ?? []) {
        expect(allowed.has(tag)).toBe(true);
      }
    }
  });

  it("covers core/built-in config paths with tags", () => {
    const schema = buildConfigSchema();
    const allowed = new Set<string>(CONFIG_TAGS);
    for (const [key, hint] of Object.entries(schema.uiHints)) {
      if (!key.includes(".")) {
        continue;
      }
      const tags = hint.tags ?? [];
      expect(tags.length, `expected tags for ${key}`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(allowed.has(tag), `unexpected tag ${tag} on ${key}`).toBe(true);
      }
    }
  });
});
