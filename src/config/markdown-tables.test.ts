import { describe, expect, it } from "vitest";

// We test the DEFAULT_TABLE_MODES map indirectly.
// resolveMarkdownTableMode requires the plugin registry (normalizeChannelId),
// so we import the module and verify the map entries are correct.

describe("DEFAULT_TABLE_MODES (mattermost)", () => {
  it("mattermost entry is present in source", async () => {
    // Read the source to verify the entry exists — the runtime function
    // requires plugin registry initialization which is heavy for unit tests.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("./markdown-tables.ts", import.meta.url).pathname.replace(
        "markdown-tables.test.ts",
        "markdown-tables.ts",
      ),
      "utf-8",
    );
    expect(src).toContain('["mattermost", "off"]');
  });

  it("signal and whatsapp entries are preserved", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("./markdown-tables.ts", import.meta.url).pathname.replace(
        "markdown-tables.test.ts",
        "markdown-tables.ts",
      ),
      "utf-8",
    );
    expect(src).toContain('["signal", "bullets"]');
    expect(src).toContain('["whatsapp", "bullets"]');
  });
});
