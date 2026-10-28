import { afterEach, expect, it, vi } from "vitest";
import type { DegradedSecretOwner } from "../secrets/runtime-degraded-state.js";
import { logPreparedSecretDegradations } from "./server-startup-secret-diagnostics.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["auth profile migration required", "auth profile migration required", "doctor --fix", ""],
  [
    "auth profile migration required",
    "auth profile migration required",
    "doctor --fix",
    "repair-test",
  ],
  ["secret reference was not found", "secret reference was not found", "secrets reload", ""],
  ["private unknown reason", "secret resolution failed", "secrets reload", ""],
])(
  "reports the remedy for %s in Gateway warnings (%s, %s, %s)",
  (reason, redacted, command, profile) => {
    vi.stubEnv("OPENCLAW_PROFILE", profile);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
    const owner: DegradedSecretOwner = {
      ownerKind: "route",
      ownerId: "legacy-agent",
      state: "unavailable",
      degradationState: "cold",
      paths: ["auth-profile-legacy:auth-profiles"],
      refKeys: [],
      reason,
    };
    const retryHint = `openclaw${profile ? ` --profile ${profile}` : ""} ${command}`;
    const warn = vi.fn();

    logPreparedSecretDegradations({ info: vi.fn(), warn }, [owner]);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `[SECRETS_DEGRADED] cold route:legacy-agent: ${redacted}. Retry: ${retryHint}.`,
      expect.objectContaining({ reason: redacted, retryHint }),
    );
  },
);
