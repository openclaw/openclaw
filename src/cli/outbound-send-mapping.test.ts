import { describe, expect, it, vi } from "vitest";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

describe("createOutboundSendDepsFromCliSource", () => {
  it("passes channel-keyed send deps through", () => {
    const deps = {
      whatsapp: vi.fn(),
      telegram: vi.fn(),
      discord: vi.fn(),
      slack: vi.fn(),
      signal: vi.fn(),
      imessage: vi.fn(),
    };

    const outbound = createOutboundSendDepsFromCliSource(deps);

    expect(outbound).toEqual({
      whatsapp: deps.whatsapp,
      telegram: deps.telegram,
      discord: deps.discord,
      slack: deps.slack,
      signal: deps.signal,
      imessage: deps.imessage,
    });
  });
});
