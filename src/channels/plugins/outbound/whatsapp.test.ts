import { describe, expect, it } from "vitest";
import { whatsappOutbound } from "./whatsapp.js";

describe("whatsappOutbound.resolveTarget", () => {
  it("returns error when no target is provided even with allowFrom", () => {
    const result = whatsappOutbound.resolveTarget?.({
      to: undefined,
      allowFrom: ["+15551234567"],
      mode: "implicit",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.any(Error),
    });
  });

  it("returns error when implicit target is not in allowFrom", () => {
    const result = whatsappOutbound.resolveTarget?.({
      to: "+15550000000",
      allowFrom: ["+15551234567"],
      mode: "implicit",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.any(Error),
    });
  });

  it("keeps group JID targets even when allowFrom does not contain them", () => {
    const result = whatsappOutbound.resolveTarget?.({
      to: "120363401234567890@g.us",
      allowFrom: ["+15551234567"],
      mode: "implicit",
    });

    expect(result).toEqual({
      ok: true,
      to: "120363401234567890@g.us",
    });
  });
});
