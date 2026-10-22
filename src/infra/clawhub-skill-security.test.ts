import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchClawHubSkillSecurityVerdicts: vi.fn(),
  fetchClawHubSkillVerification: vi.fn(),
}));

vi.mock("./clawhub-skills.js", () => ({
  fetchClawHubSkillSecurityVerdicts: mocks.fetchClawHubSkillSecurityVerdicts,
  fetchClawHubSkillVerification: mocks.fetchClawHubSkillVerification,
}));

import { createDeferred } from "../../test/helpers/promise.js";
import { fetchExactClawHubSkillSecurityVerdicts } from "./clawhub-skill-security.js";

type Target = { slug: string; ownerHandle: string; version: string };
const target = (slug = "weather", ownerHandle = "alice", version = "1.2.3"): Target => ({
  slug,
  ownerHandle,
  version,
});
const verification = ({ slug, ownerHandle, version }: Target) => ({
  ok: true,
  decision: "pass",
  reasons: [],
  slug,
  publisherHandle: ownerHandle,
  version,
  skill: null,
  publisher: null,
  security: { status: "clean", passed: true },
});
const verdict = ({ slug, ownerHandle, version }: Target, overrides = {}) => ({
  ok: true,
  decision: "pass",
  reasons: [],
  requestedSlug: slug,
  requestedOwnerHandle: ownerHandle,
  requestedVersion: version,
  slug,
  version,
  publisherHandle: ownerHandle,
  security: { status: "clean", passed: true },
  ...overrides,
});
function missingSkills({ items }: { items: Array<{ slug: string; version: string }> }) {
  return Promise.resolve({
    schema: "clawhub.skill.security-verdicts.v1",
    items: items.map(({ slug, version }) => ({
      ok: false,
      decision: "fail",
      reasons: ["skill.not_found"],
      requestedSlug: slug,
      requestedVersion: version,
      slug,
      version: null,
      error: { code: "skill_not_found", message: "Skill not found" },
    })),
  });
}

describe("fetchExactClawHubSkillSecurityVerdicts", () => {
  beforeEach(() => {
    mocks.fetchClawHubSkillSecurityVerdicts.mockReset();
    mocks.fetchClawHubSkillVerification.mockReset();
  });

  it("uses exact unauthenticated verify fallbacks for owner collisions on older registries", async () => {
    mocks.fetchClawHubSkillSecurityVerdicts.mockImplementation(missingSkills);
    mocks.fetchClawHubSkillVerification.mockImplementation(
      async ({ ownerHandle }: { ownerHandle: string }) => ({
        ...verification(target("weather", ownerHandle)),
        displayName: `${ownerHandle} Weather`,
        pageUrl: `https://clawhub.ai/${ownerHandle}/skills/weather`,
        publisherDisplayName: ownerHandle,
        createdAt: 1,
        security: { status: "clean", passed: true, checkedAt: 2 },
      }),
    );

    const items = await fetchExactClawHubSkillSecurityVerdicts({
      baseUrl: "https://clawhub.ai",
      items: [target("weather", "@Alice"), target("weather", "bob")],
      skipAuth: true,
    });

    const options = {
      baseUrl: "https://clawhub.ai",
      skipAuth: true,
      timeoutMs: undefined,
      token: undefined,
    };
    expect(mocks.fetchClawHubSkillSecurityVerdicts).toHaveBeenCalledTimes(2);
    expect(mocks.fetchClawHubSkillSecurityVerdicts).toHaveBeenNthCalledWith(1, {
      ...options,
      items: [target()],
    });
    expect(mocks.fetchClawHubSkillSecurityVerdicts).toHaveBeenNthCalledWith(2, {
      ...options,
      items: [target("weather", "bob")],
    });
    expect(mocks.fetchClawHubSkillVerification).toHaveBeenCalledTimes(2);
    expect(mocks.fetchClawHubSkillVerification).toHaveBeenNthCalledWith(1, {
      ...options,
      ...target(),
    });
    expect(items.map((item) => item.publisherHandle)).toEqual(["alice", "bob"]);
    expect(items.map((item) => item.requestedOwnerHandle)).toEqual(["alice", "bob"]);
  });

  it("bounds concurrent exact verify fallbacks on older registries", async () => {
    let activeFallbacks = 0;
    let maxActiveFallbacks = 0;
    const { promise: fallbackGate, resolve: releaseFallbacks } = createDeferred();
    mocks.fetchClawHubSkillSecurityVerdicts.mockImplementation(missingSkills);
    mocks.fetchClawHubSkillVerification.mockImplementation(async (item: Target) => {
      activeFallbacks += 1;
      maxActiveFallbacks = Math.max(maxActiveFallbacks, activeFallbacks);
      await fallbackGate;
      activeFallbacks -= 1;
      return verification(item);
    });
    const targets = Array.from({ length: 8 }, (_, index) =>
      target(`skill-${index}`, `owner-${index}`, "1.0.0"),
    );

    const resultPromise = fetchExactClawHubSkillSecurityVerdicts({ items: targets });
    await vi.waitFor(() => expect(mocks.fetchClawHubSkillVerification).toHaveBeenCalledTimes(6));
    expect(maxActiveFallbacks).toBe(6);
    releaseFallbacks?.();

    await expect(resultPromise).resolves.toHaveLength(8);
    expect(mocks.fetchClawHubSkillVerification).toHaveBeenCalledTimes(8);
    expect(maxActiveFallbacks).toBe(6);
  });

  it("correlates reordered batches and fails closed on publisher mismatches", async () => {
    mocks.fetchClawHubSkillSecurityVerdicts.mockResolvedValue({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        verdict(target("calendar", "bob", "2.0.0"), { publisherHandle: "mallory" }),
        verdict(target()),
      ],
    });

    const items = await fetchExactClawHubSkillSecurityVerdicts({
      items: [target(), target("calendar", "bob", "2.0.0")],
      skipAuth: true,
    });

    expect(mocks.fetchClawHubSkillSecurityVerdicts).toHaveBeenCalledTimes(1);
    expect(items[0]).toMatchObject({
      ok: true,
      requestedOwnerHandle: "alice",
      publisherHandle: "alice",
    });
    expect(items[1]).toMatchObject({
      ok: false,
      requestedOwnerHandle: "bob",
      reasons: ["security.identity_mismatch"],
      error: { code: "identity_mismatch" },
    });
    expect(mocks.fetchClawHubSkillVerification).not.toHaveBeenCalled();
  });

  it("fails closed when a successful verdict returns a different exact version", async () => {
    mocks.fetchClawHubSkillSecurityVerdicts.mockResolvedValue({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [verdict(target(), { version: "1.2.4" })],
    });

    const [item] = await fetchExactClawHubSkillSecurityVerdicts({
      items: [target()],
    });

    expect(item).toMatchObject({
      ok: false,
      requestedOwnerHandle: "alice",
      requestedVersion: "1.2.3",
      reasons: ["security.identity_mismatch"],
      error: { code: "identity_mismatch" },
    });
  });
});
