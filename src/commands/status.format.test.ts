import { expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  formatPromptCacheCompact,
  formatStatusConfigDiagnosticEntries,
  formatTokensCompact,
} from "./status.format.js";

it("uses the same prompt-side cache math in compact and verbose output", () => {
  const session = {
    inputTokens: 500,
    cacheRead: 2_000,
    cacheWrite: 500,
    totalTokens: 5_000,
    contextTokens: 10_000,
    percentUsed: 50,
  };
  expect(formatTokensCompact(session)).toBe("5.0k/10k (50%) · 🗄️ 67% cached");
  expect(formatPromptCacheCompact(session)).toBe("67% hit · read 2.0k · write 500");
});

it("keeps the container target ahead of the profile in its repair command", () => {
  const entries = withEnv({ OPENCLAW_PROFILE: "work", OPENCLAW_CONTAINER_HINT: "staging" }, () =>
    formatStatusConfigDiagnosticEntries({
      path: "/tmp/openclaw.json",
      issues: [{ path: "gateway.port", message: "invalid" }],
    }),
  );
  expect(entries).toEqual([
    "- Config file is invalid: /tmp/openclaw.json",
    "- gateway.port: invalid",
    "- Fix: openclaw --container staging doctor --fix",
  ]);
});
