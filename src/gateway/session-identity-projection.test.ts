import { afterEach, expect, it, vi } from "vitest";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import * as profiles from "../state/user-profile-list.js";
import type { UserProfileDisplay } from "../state/user-profiles.types.js";
import {
  createPreparedSessionProfileIdentities,
  projectSessionParticipant,
  resolveSessionListProfileReference,
} from "./session-identity-projection.js";

afterEach(() => vi.restoreAllMocks());

it("projects aliases and scoped dormant references from a complete display snapshot", () => {
  const canonical = "12345678-1111-1111-1111-111111111111";
  const alias = "87654321-1111-1111-1111-111111111111";
  const hidden = "12345678-2222-2222-2222-222222222222";
  const display = { id: canonical, displayName: " Person ", hasAvatar: true, avatarRevision: "1" };
  const identities = createPreparedSessionProfileIdentities(
    new Map<string, UserProfileDisplay>([
      [canonical, display],
      [alias, display],
      [hidden, { id: hidden, displayName: null, hasAvatar: false, avatarRevision: "2" }],
    ]),
  );
  const hostDisplay = vi.spyOn(profiles, "getResidentUserProfileDisplay");
  const hostReference = vi.spyOn(profiles, "resolveUserProfileReference");
  expect(projectSessionParticipant({ type: "profile", id: alias }, identities)).toEqual({
    identity: { type: "profile", id: canonical },
    label: "Person",
    avatarUrl: expect.stringContaining(canonical),
  });
  expect(projectSessionParticipant({ type: "profile", id: "missing" }, identities)).toEqual({
    identity: { type: "profile", id: "missing" },
  });
  const resolve = (reference: string, allowed?: ReadonlySet<string>) =>
    runSynchronousWork(resolveSessionListProfileReference(reference, [], identities, allowed));
  expect(resolve(alias)).toEqual({ ok: true, value: canonical });
  expect(resolve("87654321")).toEqual({ ok: true, value: canonical });
  expect(resolve("12345678")).toEqual({ ok: false, error: "ambiguous" });
  expect(resolve("12345678", new Set([canonical]))).toEqual({ ok: true, value: canonical });
  expect(resolve("12345678", new Set())).toEqual({ ok: true, value: undefined });
  expect(resolve("missing")).toEqual({ ok: true, value: undefined });
  expect(hostDisplay).not.toHaveBeenCalled();
  expect(hostReference).not.toHaveBeenCalled();
});
