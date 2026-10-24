import { afterEach, beforeEach, expect, inject } from "vitest";
import {
  githubNetworkAttemptCounts,
  installGitHubNetworkGuard,
  setGitHubTestContext,
} from "./helpers/github-network-guard.mjs";

// Only the explicit live config owns live networking; ambient flags and profiles
// never grant access to ordinary test projects.
if (inject("githubNetwork") !== "live") {
  installGitHubNetworkGuard();
  setGitHubTestContext(() => {
    const state = expect.getState();
    return {
      file: state.testPath,
      test: state.currentTestName,
    };
  });
  let before = 0;
  beforeEach(() => {
    before = githubNetworkAttemptCounts().incidental;
  });
  afterEach(() => {
    const attempted = githubNetworkAttemptCounts().incidental - before;
    if (attempted > 0) {
      throw new Error(
        `GitHub tripwire recorded ${attempted} unexpected refusal(s); inspect the transport attribution and fix the test or fixture.`,
      );
    }
  });
}

// The dedicated live config owns this opt-in; default projects omit it.
declare module "vitest" {
  export interface ProvidedContext {
    githubNetwork: "offline" | "live";
  }
}
