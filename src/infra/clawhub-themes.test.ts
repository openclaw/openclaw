import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createThemeDefinitionFixture } from "../../test/helpers/theme-fixture.js";
import {
  browseClawHubThemes,
  clawHubThemeLocalId,
  getClawHubThemeRelease,
} from "./clawhub-themes.js";

const pinned = { id: "alice/space", version: "1.0.0" };
function release() {
  const definition = createThemeDefinitionFixture();
  return {
    ...pinned,
    name: definition.name,
    description: definition.description,
    category: "themes",
    author: { handle: "alice" },
    updatedAt: 100,
    definition,
    sha256: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
  };
}
function serve(value: unknown) {
  const fetch = vi.fn().mockImplementation(async () => Response.json(value));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("uses configured ClawHub paths, pagination and public unauthenticated requests", async () => {
  vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://registry.example/base");
  vi.stubEnv("CLAWHUB_TOKEN", "test-secret-not-for-themes");
  const { definition: _definition, sha256: _sha256, ...summary } = release();
  const fetch = serve({ items: [summary], nextCursor: "opaque-next" });
  await expect(
    browseClawHubThemes({ query: "space & stars", cursor: "page/2", limit: 3 }),
  ).resolves.toEqual({ items: [summary], nextCursor: "opaque-next" });
  const [url, options] = expectDefined(fetch.mock.calls[0], "theme browse request");
  expect(String(url)).toBe(
    "https://registry.example/base/api/v1/themes?limit=3&cursor=page%2F2&q=space+%26+stars",
  );
  expect(options.headers).toBeUndefined();
});

it("normalizes a pinned data-only definition before checking its canonical digest", async () => {
  const item = release();
  item.definition = { ...item.definition, name: "  " + item.definition.name + "  " };
  serve({ item });
  const result = await getClawHubThemeRelease(pinned);
  expect(result.definition).toEqual(createThemeDefinitionFixture());
});

it.each([
  ["wrong category", { category: "themes-plugin" }],
  ["wrong package", { id: "other/space" }],
  ["wrong version", { version: "2.0.0" }],
  ["wrong author", { author: { handle: "other" } }],
  ["wrong digest", { sha256: "0".repeat(64) }],
  ["executable package", { tarball: "https://registry.example/package.tgz" }],
  ["asset manifest", { assets: { icon: "https://registry.example/icon.svg" } }],
  [
    "executable CSS",
    {
      definition: createThemeDefinitionFixture({
        dark: { ...createThemeDefinitionFixture().dark!, background: "url(https://evil.example)" },
      }),
    },
  ],
  [
    "external font",
    {
      definition: createThemeDefinitionFixture({
        dark: {
          ...createThemeDefinitionFixture().dark!,
          "font-sans": "sans-serif;@import url(https://evil.example)",
        },
      }),
    },
  ],
  ["custom artwork", { definition: createThemeDefinitionFixture({ brandIcon: "remote-icon" }) }],
])("rejects %s at the release boundary", async (_label, patch) => {
  serve({ item: { ...release(), ...patch } });
  await expect(getClawHubThemeRelease(pinned)).rejects.toThrow();
});

it.each([
  { items: [{}], nextCursor: null },
  { items: [], nextCursor: 2 },
  { items: [], nextCursor: null, packages: [] },
])("rejects malformed catalog envelopes", async (response) => {
  serve(response);
  await expect(browseClawHubThemes({})).rejects.toThrow("Malformed");
});

it("rejects duplicate themes and more results than requested", async () => {
  const { definition: _definition, sha256: _sha256, ...summary } = release();
  serve({ items: [summary, summary], nextCursor: null });
  await expect(browseClawHubThemes({ limit: 1 })).rejects.toThrow("Malformed");
  await expect(browseClawHubThemes({ limit: 2 })).rejects.toThrow("identity");
});

it("bounds response bytes and derives stable distinct personal slugs", async () => {
  serve({ padding: "x".repeat(128 * 1024) });
  await expect(browseClawHubThemes({})).rejects.toThrow("exceeded");
  const id = "alice/" + "a".repeat(64);
  expect(clawHubThemeLocalId(id)).toHaveLength(64);
  expect(clawHubThemeLocalId(id)).toBe(clawHubThemeLocalId(id));
  expect(clawHubThemeLocalId(id)).not.toBe(clawHubThemeLocalId("bob/" + "a".repeat(64)));
});
