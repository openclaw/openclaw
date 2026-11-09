import { describe, expect, it } from "vitest";
import {
  type OfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

// Vendor-maintained entries pin an exact published version plus its registry
// integrity, unlike the floating @openclaw/* entries covered by the main suite.
function expectCatalogEntry(id: string): OfficialExternalPluginCatalogEntry {
  const entry = getOfficialExternalPluginCatalogEntry(id);
  if (entry === undefined) {
    throw new Error(`Expected external plugin catalog entry for ${id}`);
  }
  return entry;
}

describe("official external plugin catalog vendor pins", () => {
  it("pins the vendor-maintained Telnyx provider to the reviewed npm artifact", () => {
    const entry = expectCatalogEntry("telnyx");

    expect(entry).toMatchObject({
      name: "@telnyx/openclaw-provider",
      source: "external",
      kind: "provider",
      openclaw: {
        plugin: { id: "telnyx", label: "Telnyx" },
        providers: [
          {
            id: "telnyx",
            name: "Telnyx",
            docs: "/providers/telnyx",
            envVars: ["TELNYX_API_KEY"],
            authChoices: [
              {
                method: "api-key",
                choiceId: "telnyx-api-key",
                choiceLabel: "Telnyx API key",
                choiceHint: "OpenAI-compatible Telnyx AI inference endpoint",
                groupId: "telnyx",
                groupLabel: "Telnyx",
                groupHint: "OpenAI-compatible Telnyx AI inference endpoint",
                optionKey: "telnyxApiKey",
                cliFlag: "--telnyx-api-key",
                cliOption: "--telnyx-api-key <key>",
                cliDescription: "Telnyx API key",
                onboardingScopes: ["text-inference"],
              },
            ],
          },
        ],
      },
    });
    expect(resolveOfficialExternalPluginInstall(entry)).toEqual({
      clawhubSpec: "clawhub:@telnyx/openclaw-provider@0.2.0",
      npmSpec: "@telnyx/openclaw-provider@0.2.0",
      defaultChoice: "npm",
      expectedIntegrity:
        "sha512-htqOJfPx+TlLWE/nmpdJJVgrg8zDqRIX87smzY3CnKcdJPlx51Rc1kWzarvE+2hvhpm2lzD5sKkxRSIWKz2AaA==",
      minHostVersion: ">=2026.8.1",
    });
  });
});
