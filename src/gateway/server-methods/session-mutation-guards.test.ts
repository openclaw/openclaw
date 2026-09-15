import { describe, expect, it } from "vitest";
import {
  bindWorkerSourceAuthorization,
  isWorkerSourceAuthorization,
} from "../worker-environments/service-contract.js";
import { withSessionMutationCommitGuard } from "./session-mutation-guards.js";

describe("session mutation authority composition", () => {
  it("keeps admitted input custody independent of later profile selection without losing source authority", () => {
    let sourceLive = true;
    let selectedProfileCurrent = true;
    const source = bindWorkerSourceAuthorization(() => {
      if (!sourceLive) {
        throw new Error("source closed");
      }
    });
    const authority = withSessionMutationCommitGuard(undefined, source, () => {
      if (!selectedProfileCurrent) {
        throw new Error("profile changed");
      }
    });
    if (!authority?.assertAdmittedInputCurrent) {
      throw new Error("missing input custody");
    }
    expect(isWorkerSourceAuthorization(authority.assertCurrent)).toBe(true);
    expect(isWorkerSourceAuthorization(authority.assertAdmittedInputCurrent)).toBe(true);
    selectedProfileCurrent = false;
    expect(authority.assertCurrent).toThrow("profile changed");
    expect(authority.assertAdmittedInputCurrent).not.toThrow();
    sourceLive = false;
    expect(authority.assertAdmittedInputCurrent).toThrow("source closed");
  });
});
