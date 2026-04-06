import { describe, expect, it } from "vitest";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "./provider-registry-shared.js";

describe("provider registry shared", () => {
  it("normalizes provider ids case-insensitively", () => {
    expect(normalizeCapabilityProviderId("  OpenAI  ")).toBe("openai");
    expect(normalizeCapabilityProviderId("   ")).toBeUndefined();
  });

  it("indexes providers by id and alias", () => {
    const { canonical, aliases } = buildCapabilityProviderMaps([
      { id: "Microsoft", aliases: [" EDGE ", "ms"] },
      { id: "OpenAI" },
    ]);

    expect([...canonical.keys()]).toEqual(["microsoft", "openai"]);
    expect(aliases.get("edge")?.id).toBe("Microsoft");
    expect(aliases.get("ms")?.id).toBe("Microsoft");
    expect(aliases.get("openai")?.id).toBe("OpenAI");
  });
});
