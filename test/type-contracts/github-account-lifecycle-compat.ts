import type { LegacyGitHubOAuthService } from "openclaw/plugin-sdk/native-github-account-host";
import { expectTypeOf } from "vitest";
import type { createGitHubOAuthLifecycle } from "../../extensions/github-repositories/oauth-lifecycle-api.js";

// Keep the complete released service shape alongside the unchanged context-entry assertions.
// Inference stays at the implementation so this comparison cannot hide removed members.
type ManagedGitHub = ReturnType<typeof createGitHubOAuthLifecycle>;
expectTypeOf<ManagedGitHub>().toEqualTypeOf<LegacyGitHubOAuthService>();
expectTypeOf<LegacyGitHubOAuthService>().toEqualTypeOf<ManagedGitHub>();
