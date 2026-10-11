import { describe, expect, it } from "vitest";
import { applySharedChannelFieldHelp } from "./schema.channel-field-help.js";

describe("applySharedChannelFieldHelp", () => {
  it("keeps the tier and any other hint fields the path already carries", () => {
    const next = applySharedChannelFieldHelp({
      "channels.whatsapp.allowFrom": { advanced: false, presentation: "phone-number" },
    });

    expect(next["channels.whatsapp.allowFrom"]).toMatchObject({
      advanced: false,
      presentation: "phone-number",
    });
  });
});
