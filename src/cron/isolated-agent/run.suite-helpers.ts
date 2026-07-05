/** Shared setup helpers for isolated-agent run test suites. */
import { afterEach, beforeEach } from "vitest";
<<<<<<< HEAD
=======
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  clearFastTestEnv,
  makeCronSession,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
} from "./run.test-harness.js";

/** Installs the common before/after hooks for isolated-agent run suites. */
export function setupRunCronIsolatedAgentTurnSuite(options?: { fast?: boolean }) {
  let previousFastTestEnv: string | undefined;
  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    if (options?.fast) {
      process.env.OPENCLAW_TEST_FAST = "1";
    }
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
  });
  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });
}
<<<<<<< HEAD
=======

export const makeIsolatedAgentTurnJob = makeIsolatedAgentJobFixture;
export const makeIsolatedAgentTurnParams = makeIsolatedAgentParamsFixture;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
