import { describe, expect, it } from "vitest";

import { buildConfigSchema } from "./schema.js";

describe("config schema", () => {
  it("exports schema + hints", () => {
    const res = buildConfigSchema();
    const schema = res.schema as { properties?: Record<string, unknown> };
    expect(schema.properties?.gateway).toBeTruthy();
    expect(schema.properties?.agents).toBeTruthy();
    expect(res.uiHints.gateway?.label).toBe("Gateway");
    expect(res.uiHints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(res.version).toBeTruthy();
    expect(res.generatedAt).toBeTruthy();
  });

  it("merges plugin ui hints", () => {
    const res = buildConfigSchema({
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          description: "Outbound voice calls",
          configUiHints: {
            provider: { label: "Provider" },
            "twilio.authToken": { label: "Auth Token", sensitive: true },
          },
        },
      ],
    });

    expect(res.uiHints["plugins.entries.voice-call"]?.label).toBe("Voice Call");
    expect(res.uiHints["plugins.entries.voice-call.config"]?.label).toBe(
      "Voice Call Config",
    );
    expect(
      res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.label,
    ).toBe("Auth Token");
    expect(
      res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]
        ?.sensitive,
    ).toBe(true);
  });
});
