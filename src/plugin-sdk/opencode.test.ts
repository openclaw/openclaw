import { describe, expect, it } from "vitest";
import { createOpencodeCatalogApiKeyAuthMethod } from "./opencode.js";

describe("createOpencodeCatalogApiKeyAuthMethod", () => {
  it("locks the shared OpenCode auth contract", () => {
    const method = createOpencodeCatalogApiKeyAuthMethod({
      providerId: "opencode-go",
      label: "OpenCode Go catalog",
      optionKey: "opencodeGoApiKey",
      flagName: "--opencode-go-api-key",
      envVar: "OPENCODE_GO_API_KEY",
      defaultModel: "opencode-go/kimi-k2.6",
      applyConfig: (cfg) => cfg,
      noteMessage: "OpenCode Go prefers OPENCODE_GO_API_KEY.",
      choiceId: "opencode-go",
      choiceLabel: "OpenCode Go catalog",
    });

    expect(method.id).toBe("api-key");
    expect(method.label).toBe("OpenCode Go catalog");
    expect(method.hint).toBe(
      "Prefers a provider-specific OpenCode key; falls back to OPENCODE_API_KEY",
    );
    expect(method.kind).toBe("api_key");
    if (!method.wizard) {
      throw new Error("expected OpenCode auth method to include wizard metadata");
    }
    expect(method.wizard.choiceId).toBe("opencode-go");
    expect(method.wizard.choiceLabel).toBe("OpenCode Go catalog");
    expect(method.wizard.groupId).toBe("opencode");
    expect(method.wizard.groupLabel).toBe("OpenCode");
    expect(method.wizard.groupHint).toBe(
      "Prefers a provider-specific OpenCode key; falls back to OPENCODE_API_KEY",
    );
  });
});
