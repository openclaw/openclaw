import { describe, expect, it } from "vitest";
import {
  type AuthProfileFailureReason,
  type AuthProfileStore,
  resolveProfilesUnavailableReason,
} from "./agent-runtime.js";

function preserveExhaustiveFailureReasonHandling(
  reason: AuthProfileFailureReason,
): AuthProfileFailureReason {
  switch (reason) {
    case "auth":
    case "auth_permanent":
    case "format":
    case "overloaded":
    case "rate_limit":
    case "billing":
    case "timeout":
    case "model_not_found":
    case "session_expired":
    case "empty_response":
    case "no_error_details":
    case "unclassified":
    case "unknown":
      return reason;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function consumeCanonicalReasonFromPublicStore(
  store: AuthProfileStore,
  profileId: string,
): AuthProfileFailureReason {
  const reason = store.usageStats?.[profileId]?.cooldownReason;
  if (!reason) {
    throw new Error("expected canonical cooldown reason");
  }
  return preserveExhaustiveFailureReasonHandling(reason);
}

describe("agent-runtime auth profile contract", () => {
  it("keeps the canonical reason independent of diagnostic classification", () => {
    const now = 1_700_000_000_000;
    const profileId = "openai:default";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {},
      usageStats: {
        [profileId]: {
          cooldownUntil: now + 60_000,
          cooldownReason: "rate_limit",
          cooldownClassification: "wham_account_dead",
        },
      },
    };

    expect(consumeCanonicalReasonFromPublicStore(store, profileId)).toBe("rate_limit");
    expect(resolveProfilesUnavailableReason({ store, profileIds: [profileId], now })).toBe(
      "rate_limit",
    );
  });
});
