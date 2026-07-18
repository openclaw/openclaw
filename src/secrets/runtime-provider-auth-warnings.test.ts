/** Tests provider-auth warning projection during scoped credential refreshes. */
import { describe, expect, it } from "vitest";
import { selectProviderAuthRuntimeWarnings } from "./runtime-provider-auth-warnings.js";
import type { SecretResolverWarning } from "./runtime-shared.js";

describe("provider-auth runtime warning projection", () => {
  it("drops warnings for transport and web owners whose candidate state is discarded", () => {
    const warning = (path: string): SecretResolverWarning => ({
      code: "SECRETS_OWNER_UNAVAILABLE",
      path,
      message: "redacted fixture warning",
    });

    expect(
      selectProviderAuthRuntimeWarnings([
        warning("models.providers.openai.apiKey"),
        warning("/tmp/agent.auth-profiles.openai:default.key"),
        warning("channels.discord.accounts.ops.token"),
        warning("plugins.entries.brave.config.webSearch.apiKey"),
      ]),
    ).toEqual([
      warning("models.providers.openai.apiKey"),
      warning("/tmp/agent.auth-profiles.openai:default.key"),
    ]);
  });
});
