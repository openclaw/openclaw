/** Tests provider-auth warning projection during scoped credential refreshes. */
import { describe, expect, it } from "vitest";
import { mergeProviderAuthRuntimeWarnings } from "./runtime-provider-auth-warnings.js";
import type { SecretResolverWarning } from "./runtime-shared.js";

describe("provider-auth runtime warning projection", () => {
  it.each([
    "models.providers.openai.apiKey",
    'models.providers["123"].apiKey',
    'models.providers["local.service"].apiKey',
  ])(
    "replaces and clears provider-auth warnings at %s while retaining unrelated warnings",
    (providerPath) => {
      const warning = (
        path: string,
        message = "redacted fixture warning",
      ): SecretResolverWarning => ({
        code: "SECRETS_OWNER_UNAVAILABLE",
        path,
        message,
      });

      expect(
        mergeProviderAuthRuntimeWarnings(
          [
            warning(providerPath, "old provider warning"),
            warning("channels.discord.accounts.ops.token", "active transport warning"),
            warning("plugins.entries.brave.config.webSearch.apiKey", "active web warning"),
          ],
          [
            warning(providerPath, "current provider warning"),
            warning("/tmp/agent.auth-profiles.openai:default.key", "current auth warning"),
            warning("channels.discord.accounts.ops.token", "discarded candidate warning"),
          ],
        ),
      ).toEqual([
        warning("channels.discord.accounts.ops.token", "active transport warning"),
        warning("plugins.entries.brave.config.webSearch.apiKey", "active web warning"),
        warning(providerPath, "current provider warning"),
        warning("/tmp/agent.auth-profiles.openai:default.key", "current auth warning"),
      ]);
      expect(
        mergeProviderAuthRuntimeWarnings(
          [
            warning(providerPath, "recovered provider warning"),
            warning("channels.discord.accounts.ops.token", "active transport warning"),
          ],
          [],
        ),
      ).toEqual([warning("channels.discord.accounts.ops.token", "active transport warning")]);
    },
  );
});
