import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  profile: { profileId: "guest-a", assignedRole: "guest", githubLogin: "guest-a" },
  scopes: ["operator.sessions.write"],
  controller: new AbortController(),
  unavailable: false,
  release: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("../../state/user-profile-list.js", () => ({
  prepareUserProfileIdentity: vi.fn(async () => ({
    readCurrentFacts: () => ({ profile: state.profile, aliases: new Set<string>() }),
    release: state.release,
  })),
}));
vi.mock("../operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../operator-role-policy.js")>()),
  resolveOperatorRolePolicyForAssignment: () => ({ scopes: state.scopes }),
}));
vi.mock("../operator-access-policy.js", () => {
  class GatewayOperatorAccessDeniedError extends Error {}
  return {
    GatewayOperatorAccessDeniedError,
    resumeGatewayOperatorAccessGrant: (...args: unknown[]) => {
      state.resume(...args);
      if (state.unavailable) {
        throw new Error("admission is unavailable");
      }
      if (state.controller.signal.aborted) {
        throw new GatewayOperatorAccessDeniedError();
      }
      return {
        signal: state.controller.signal,
        assertCurrent: () => {
          if (state.controller.signal.aborted) {
            throw new GatewayOperatorAccessDeniedError();
          }
        },
      };
    },
  };
});

import { emitUserProfilesChanged } from "../../state/user-profile-events.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import {
  prepareSessionGuestAuthority,
  readSessionGuestBinding,
  SessionGuestAccessRevokedError,
} from "./session-guest.js";

const binding = {
  profileId: "guest-a",
  sessionId: "session-a",
  grant: { pluginId: "visitor-access", grantId: "grant-a" },
};

beforeEach(() => {
  state.profile = { profileId: "guest-a", assignedRole: "guest", githubLogin: "guest-a" };
  state.scopes = ["operator.sessions.write"];
  state.controller = new AbortController();
  state.unavailable = false;
  state.release.mockClear();
  state.resume.mockClear();
});

describe("persisted guest environment authority", () => {
  it("resumes the exact original grant and preserves its revocation signal", async () => {
    const authority = await prepareSessionGuestAuthority(binding, () => ({}));
    expect(authority.signal).not.toBe(state.controller.signal);
    expect(authority.signal.aborted).toBe(false);
    authority.assertCurrent();
    expect(state.resume).toHaveBeenLastCalledWith(
      state.profile,
      {},
      binding.grant,
      expect.any(Object),
    );
    state.controller.abort();
    expect(() => authority.assertCurrent()).toThrow(SessionGuestAccessRevokedError);
    authority.release();
    expect(state.release).toHaveBeenCalledOnce();
  });

  it.each(["principal", "role"])("rejects changed %s authority at the effect", async (change) => {
    const authority = await prepareSessionGuestAuthority(binding, () => ({}));
    if (change === "principal") {
      state.profile.profileId = "guest-b";
    } else {
      state.scopes = ["operator.read"];
    }
    expect(() => authority.assertCurrent()).toThrow(SessionGuestAccessRevokedError);
    authority.release();
  });

  it("latches an observed role denial even if permissions are restored", async () => {
    const authority = await prepareSessionGuestAuthority(binding, () => ({}));
    state.scopes = ["operator.read"];
    expect(() => authority.assertCurrent()).toThrow(SessionGuestAccessRevokedError);
    expect(authority.signal.aborted).toBe(true);
    state.scopes = ["operator.sessions.write"];
    expect(() => authority.assertCurrent()).toThrow(SessionGuestAccessRevokedError);
    authority.release();
  });

  it.each(["role", "profile"])(
    "detects definite %s changes without another operation and cannot revive",
    async (change) => {
      const authority = await prepareSessionGuestAuthority(binding, () => ({}));
      state.scopes = ["operator.read"];
      if (change === "role") {
        invalidateOperatorRolePolicy(binding.profileId);
      } else {
        emitUserProfilesChanged();
      }
      expect(authority.signal.aborted).toBe(true);
      state.scopes = ["operator.sessions.write"];
      invalidateOperatorRolePolicy(binding.profileId);
      expect(() => authority.assertCurrent()).toThrow(SessionGuestAccessRevokedError);
      authority.release();
    },
  );

  it("does not retire a retained capability for temporarily unavailable policy", async () => {
    const authority = await prepareSessionGuestAuthority(binding, () => ({}));
    state.unavailable = true;
    invalidateOperatorRolePolicy(binding.profileId);
    expect(authority.signal.aborted).toBe(false);
    expect(() => authority.assertCurrent()).toThrow("admission is unavailable");
    state.unavailable = false;
    authority.assertCurrent();
    expect(authority.signal.aborted).toBe(false);
    authority.release();
  });

  it("does not classify unavailable admission as a definite revocation", async () => {
    state.unavailable = true;
    await expect(prepareSessionGuestAuthority(binding, () => ({}))).rejects.toThrow(
      "admission is unavailable",
    );
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("does not resume an already-revoked grant", async () => {
    state.controller.abort();
    await expect(prepareSessionGuestAuthority(binding, () => ({}))).rejects.toThrow(
      SessionGuestAccessRevokedError,
    );
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("reads a host binding without allowing malformed state to become a trusted worker", () => {
    expect(readSessionGuestBinding({})).toBeUndefined();
    expect(readSessionGuestBinding({ sessionGuest: binding })).toEqual(binding);
    for (const sessionGuest of [
      null,
      true,
      { ...binding, sessionId: "" },
      { ...binding, grant: {} },
    ]) {
      expect(() => readSessionGuestBinding({ sessionGuest })).toThrow(
        "invalid guest authority binding",
      );
    }
  });
});
