import { describe, expect, it, vi } from "vitest";
import { createTemplateClawHubSignIn } from "./template-clawhub-sign-in.js";

function fixture() {
  const target = {
    profileId: "owner",
    baseUrl: "https://clawhub.example",
    sourceSessionKey: "agent:main:template",
    draftId: "private-draft",
    assertCurrent: vi.fn(),
  };
  let now = 100;
  const start = vi.fn(async () => ({
    deviceCode: "synthetic-device-code",
    verificationUrl: "https://clawhub.example/cli/device",
    userCode: "ZYXW-2345",
    expiresInMs: 10_000,
    intervalMs: 1_000,
  }));
  const poll = vi.fn(async () => ({ kind: "authorized" as const, token: "synthetic-token" }));
  const verify = vi.fn<() => Promise<string | null>>(async () => "fixture-creator");
  const save = vi.fn(async (scope: { assertCurrent: () => void }, _token: string) => {
    scope.assertCurrent();
  });
  const owner = createTemplateClawHubSignIn({ now: () => now, start, poll, verify, save });
  const admit = async () => {
    const result = await owner.start(target);
    if (result.status !== "pending") {
      throw new Error("Expected a pending request");
    }
    return result.requestId;
  };
  function advance(ms: number) {
    now += ms;
  }
  return { target, start, poll, verify, save, owner, admit, advance };
}

describe("Template ClawHub authorization ownership", () => {
  it("shares duplicate starts and exchanges once for two concurrent completions", async () => {
    const { owner, target, start, admit, poll, verify, save, advance } = fixture();
    const requestId = await admit();
    expect(await admit()).toBe(requestId);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await owner.poll(target, requestId)).toMatchObject({ status: "pending" });
    expect(poll).not.toHaveBeenCalled();
    advance(1_000);
    const complete = () => owner.poll(target, requestId);
    const results = await Promise.all([complete(), complete()]);
    expect(results).toEqual([{ status: "connected" }, { status: "connected" }]);
    expect(await complete()).toEqual({ status: "connected" });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledExactlyOnceWith(target.baseUrl, "synthetic-token");
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ profileId: target.profileId }),
      "synthetic-token",
    );
  });

  it("does not let a different user, conversation, draft, or registry claim a request", async () => {
    const { owner, target, admit, poll, advance } = fixture();
    const requestId = await admit();
    advance(1_000);
    for (const overrides of [
      { profileId: "other-user" },
      { sourceSessionKey: "agent:main:other" },
      { draftId: "different-draft" },
      { baseUrl: "https://other.example" },
    ]) {
      expect(await owner.poll({ ...target, ...overrides }, requestId)).toEqual({
        status: "expired",
      });
      expect(owner.cancel({ ...target, ...overrides }, requestId)).toEqual({ status: "expired" });
    }
    expect(poll).not.toHaveBeenCalled();
    expect(await owner.poll(target, requestId)).toEqual({ status: "connected" });
  });

  it("discards a token when cancellation wins during identity validation", async () => {
    const { owner, target, admit, verify, save, advance } = fixture();
    const observation = Promise.withResolvers<void>();
    const verification = Promise.withResolvers<string>();
    verify.mockImplementationOnce(() => {
      observation.resolve();
      return verification.promise;
    });
    const requestId = await admit();
    advance(1_000);
    const completion = owner.poll(target, requestId);
    await observation.promise;
    expect(owner.cancel(target, requestId)).toEqual({ status: "cancelled" });
    verification.resolve("fixture-creator");
    expect(await completion).toEqual({ status: "cancelled" });
    expect(save).not.toHaveBeenCalled();
  });

  it("never exchanges expired approval or saves an unverified token", async () => {
    const { owner, target, admit, poll, verify, save, advance } = fixture();
    const expired = await admit();
    advance(10_000);
    expect(await owner.poll(target, expired)).toEqual({ status: "expired" });
    expect(poll).not.toHaveBeenCalled();
    const requestId = await admit();
    advance(1_000);
    verify.mockResolvedValueOnce(null);
    expect(await owner.poll(target, requestId)).toEqual({ status: "failed" });
    expect(save).not.toHaveBeenCalled();
  });
});
