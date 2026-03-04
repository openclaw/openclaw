import { describe, expect, it } from "vitest";
import type { loadConfig } from "../../../config/config.js";
import { resolveGroupPolicyFor, resolveGroupRequireMentionFor } from "./group-activation.js";

// Cast to forward-compatible signature for testing multi-account accountId propagation.
// On unpatched main the functions only accept (cfg, conversationId) — the accountId
// parameter is missing, so extra args are silently ignored by JS, producing the wrong
// (channel-level) result. After the fix, the 3rd argument is honoured.
type PolicyFn = (
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string,
) => { allowed: boolean; allowlistEnabled: boolean };

type MentionFn = (
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string,
) => boolean;

const resolveGroupPolicyForFn = resolveGroupPolicyFor as unknown as PolicyFn;
const resolveGroupRequireMentionForFn = resolveGroupRequireMentionFor as unknown as MentionFn;

const makeStrictAccountCfg = () =>
  ({
    channels: {
      whatsapp: {
        // Channel-level: permissive open policy
        groupPolicy: "open",
        accounts: {
          work: {
            // "work" account: strict allowlist-only policy
            groupPolicy: "allowlist",
          },
        },
      },
    },
  }) as unknown as ReturnType<typeof loadConfig>;

describe("resolveGroupPolicyFor multi-account accountId propagation (#17817)", () => {
  it("uses account-specific allowlist policy when accountId is provided", () => {
    const cfg = makeStrictAccountCfg();
    // "work" account has groupPolicy="allowlist" with no groups configured.
    // An unknown group "999@g.us" must be blocked (not in allowlist).
    // On unpatched main, accountId is ignored → channel-level "open" → allowed=true → FAILS.
    // On fixed code, accountId is used → "work" allowlist → allowed=false → PASSES.
    const policy = resolveGroupPolicyForFn(cfg, "999@g.us", "work");
    expect(policy.allowlistEnabled).toBe(true);
    expect(policy.allowed).toBe(false);
  });

  it("channel-level open policy is used when no accountId is provided", () => {
    const cfg = makeStrictAccountCfg();
    // Without accountId, falls back to DEFAULT_ACCOUNT_ID → channel-level "open" policy.
    const policy = resolveGroupPolicyForFn(cfg, "999@g.us");
    expect(policy.allowlistEnabled).toBe(false);
    expect(policy.allowed).toBe(true);
  });
});

describe("resolveGroupRequireMentionFor multi-account accountId propagation (#17817)", () => {
  it("uses account-specific requireMention when accountId is provided", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "open",
          // No channel-level groups → requireMention defaults to false
          accounts: {
            strict: {
              // "strict" account forces mention requirement
              groupPolicy: "allowlist",
              groups: {
                "999@g.us": { requireMention: true },
              },
            },
          },
        },
      },
    } as unknown as ReturnType<typeof loadConfig>;

    // On unpatched main, accountId is ignored → no channel-level groups → returns false → FAILS.
    // On fixed code, accountId is used → strict account groups → returns true → PASSES.
    const requireMention = resolveGroupRequireMentionForFn(cfg, "999@g.us", "strict");
    expect(requireMention).toBe(true);
  });
});
