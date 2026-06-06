/**
 * Hermetic test-env helper for OPENCLAW_* variables.
 *
 * Background:
 *   Prince-seats run the openclaw-gateway as a systemd unit. The unit exports
 *   a number of OPENCLAW_* environment variables to every child process,
 *   including any shell launched from the seat. When `pnpm test` is invoked
 *   from that shell, those vars leak into the test process and trip impl
 *   branches that the tests assume are inert by default (e.g.
 *   `isCliOnlyProcess()`, the future-version-guard service-mode block, the
 *   destructive-actions bypass flag, etc.). Tests that pass cleanly in CI or
 *   in an env-clean shell then fail spuriously at the seat.
 *
 *   The exact set of leaked vars varies per seat (operator-set overrides,
 *   different systemd unit drop-ins, etc.), so enumerating known offenders
 *   in each test file is fragile by construction. Cross-seat cosign-by-byte
 *   on PR #844 surfaced this: lamp-NUC + silas-seat verified hermetic with
 *   two vars stubbed, cael-seat needed a third because his systemd unit
 *   exports `OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1`.
 *
 * Cure:
 *   `useHermeticOpenclawEnv()` registers a `beforeEach` that snapshots and
 *   stubs every `OPENCLAW_*` key present in `process.env` to the empty
 *   string, plus an `afterEach` that restores via `vi.unstubAllEnvs()`.
 *   Wildcards over the namespace so new vars at any seat are caught
 *   automatically without a follow-up PR. Companion tests that need a
 *   specific `OPENCLAW_*` value can still set it explicitly inside the test
 *   body (via `vi.stubEnv` or direct `process.env` write); the helper's
 *   stub is a default, not a lock.
 *
 * Usage:
 *   import { useHermeticOpenclawEnv } from "../../../test/vitest/hermetic-openclaw-env";
 *
 *   describe("my suite", () => {
 *     useHermeticOpenclawEnv();
 *     // ... tests ...
 *   });
 *
 *   If the suite already has its own `beforeEach`/`afterEach`, call
 *   `useHermeticOpenclawEnv()` before them; vitest runs hooks in
 *   registration order so the env stub lands first and the unstub runs
 *   last, leaving any per-test mock state intact.
 */

import { afterEach, beforeEach, vi } from "vitest";

const OPENCLAW_ENV_PREFIX = "OPENCLAW_";

export interface HermeticOpenclawEnvOptions {
  /**
   * `OPENCLAW_*` keys to leave untouched. Use for tests that set state-dir,
   * config-path, or other workspace-rooting vars in `beforeAll` and rely on
   * them persisting across the suite.
   */
  except?: readonly string[];
}

export function useHermeticOpenclawEnv(options: HermeticOpenclawEnvOptions = {}): void {
  const exceptSet = new Set(options.except ?? []);
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(OPENCLAW_ENV_PREFIX) && !exceptSet.has(key)) {
        vi.stubEnv(key, "");
      }
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
}
