import { describe, expect, it, vi } from "vitest";
import { emitUserProfilesChanged } from "../state/user-profile-events.js";
import { createChannelOperatorRevocation } from "./channel-operator-revocation.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";

const changed = "Channel operator authority changed; send a new request.";

function createSource() {
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) {
      throw new Error(changed);
    }
  });
  return {
    assertCurrent,
    revocation: createChannelOperatorRevocation({ profileId: "channel-admin", assertCurrent }),
    revoke: () => {
      current = false;
    },
  };
}

describe("channel operator revocation", () => {
  it.each([
    ["a committed profile or link change", emitUserProfilesChanged],
    ["a committed role configuration change", () => publishOperatorRoleConfigChange({})],
  ])("aborts retained work on %s", (_name, publish) => {
    const source = createSource();
    const release = source.revocation.retain();
    source.revoke();
    publish();
    expect(source.revocation.signal.reason).toEqual(new Error(changed));
    // A refused source stays refused, and later holders cannot retain it.
    expect(() => source.revocation.assertCurrent()).toThrow(changed);
    expect(() => source.revocation.retain()).toThrow(changed);
    release();
  });

  it("latches a refusal found by any check into the signal, without a published change", () => {
    const source = createSource();
    const release = source.revocation.retain();
    source.revoke();
    expect(() => source.revocation.assertCurrent()).toThrow(changed);
    expect(source.revocation.signal.reason).toEqual(new Error(changed));
    release();
  });

  it("follows the access grant's own revocation signal", () => {
    const grant = new AbortController();
    const revocation = createChannelOperatorRevocation({
      profileId: "channel-admin",
      assertCurrent: () => {},
      signal: grant.signal,
    });
    const release = revocation.retain();
    grant.abort(new Error("access grant expired"));
    expect(revocation.signal.reason).toEqual(new Error("access grant expired"));
    release();
  });

  it("listens only while work retains the source", () => {
    const source = createSource();
    // Unretained message authority neither subscribes nor rechecks.
    emitUserProfilesChanged();
    expect(source.assertCurrent).not.toHaveBeenCalled();
    const first = source.revocation.retain();
    const second = source.revocation.retain();
    emitUserProfilesChanged();
    expect(source.assertCurrent).toHaveBeenCalledTimes(3);
    first();
    first();
    emitUserProfilesChanged();
    expect(source.assertCurrent).toHaveBeenCalledTimes(4);
    second();
    source.revoke();
    emitUserProfilesChanged();
    expect(source.assertCurrent).toHaveBeenCalledTimes(4);
    expect(source.revocation.signal.aborted).toBe(false);
    // The next holder's admission check still refuses the changed source.
    expect(() => source.revocation.retain()).toThrow(changed);
    expect(source.revocation.signal.aborted).toBe(true);
  });
});
