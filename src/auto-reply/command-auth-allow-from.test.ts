import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandsAllowFromList } from "./command-auth.js";

function makeConfig(commandsAllowFrom?: Record<string, Array<string | number>>): OpenClawConfig {
  return {
    commands: commandsAllowFrom ? { allowFrom: commandsAllowFrom } : undefined,
  } as OpenClawConfig;
}

describe("resolveCommandsAllowFromList", () => {
  it("returns null when commands.allowFrom is not configured", () => {
    const cfg = makeConfig(undefined);
    expect(resolveCommandsAllowFromList({ cfg })).toBeNull();
  });

  it("returns null when commands.allowFrom is an empty object", () => {
    const cfg = makeConfig({});
    expect(resolveCommandsAllowFromList({ cfg, providerId: "telegram" })).toBeNull();
  });

  it("returns provider-specific list when configured", () => {
    const cfg = makeConfig({ telegram: ["123456789", "987654321"] });
    const result = resolveCommandsAllowFromList({ cfg, providerId: "telegram" });
    expect(result).toEqual(["123456789", "987654321"]);
  });

  it("falls back to global '*' list when provider key is absent", () => {
    const cfg = makeConfig({ "*": ["111", "222"] });
    const result = resolveCommandsAllowFromList({ cfg, providerId: "telegram" });
    expect(result).toEqual(["111", "222"]);
  });

  it("prefers provider-specific over global '*' list", () => {
    const cfg = makeConfig({ telegram: ["tg-only"], "*": ["global"] });
    const result = resolveCommandsAllowFromList({ cfg, providerId: "telegram" });
    expect(result).toEqual(["tg-only"]);
  });

  it("returns null when neither provider nor '*' key exists", () => {
    const cfg = makeConfig({ whatsapp: ["123"] });
    const result = resolveCommandsAllowFromList({ cfg, providerId: "telegram" });
    expect(result).toBeNull();
  });

  it("formats entries through dock formatAllowFrom when dock is provided", () => {
    const cfg = makeConfig({ telegram: ["UserName", "123456"] });
    // When dock with formatAllowFrom is provided, entries get normalized.
    // Without a dock, entries are returned as trimmed strings.
    const result = resolveCommandsAllowFromList({ cfg, providerId: "telegram" });
    expect(result).toEqual(["UserName", "123456"]);
  });
});
