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
const pass = {
  ok: true,
  decision: "pass",
  reasons: [],
  security: { status: "clean", passed: true },
};
const verification = ({ slug, ownerHandle, version }: Target) => ({
  ...pass,
  slug,
  publisherHandle: ownerHandle,
  version,
  skill: null,
  publisher: null,
});
const verdict = ({ slug, ownerHandle, version }: Target, overrides = {}) => ({
  ...pass,
  requestedSlug: slug,
  requestedOwnerHandle: ownerHandle,
  requestedVersion: version,
  slug,
  version,
  publisherHandle: ownerHandle,
  ...overrides,
});
const batch = (items: ReturnType<typeof verdict>[]) =>
  mocks.fetchClawHubSkillSecurityVerdicts.mockResolvedValue({
    schema: "clawhub.skill.security-verdicts.v1",
    items,
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
    mocks.fetchClawHubSkillVerification.mockImplementation(async (item: Target) => ({
      ...verification(item),
      displayName: `${item.ownerHandle} Weather`,
      pageUrl: `https://clawhub.ai/${item.ownerHandle}/skills/weather`,
      publisherDisplayName: item.ownerHandle,
      createdAt: 1,
      security: { status: "clean", passed: true, checkedAt: 2 },
    }));

    const items = await fetchExactClawHubSkillSecurityVerdicts({
      baseUrl: "https://clawhub.ai",
      items: [target("weather", "@Alice"), target("weather", "bob")],
      skipAuth: true,
    });

    expect(
      [
        ...mocks.fetchClawHubSkillSecurityVerdicts.mock.calls,
        ...mocks.fetchClawHubSkillVerification.mock.calls,
      ].map(([options]) => options.skipAuth),
    ).toEqual([true, true, true, true]);
    expect(items.map(({ ok, slug, version }) => [ok, slug, version])).toEqual([
      [true, "weather", "1.2.3"],
      [true, "weather", "1.2.3"],
    ]);
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

  it.each([{ publisherHandle: "mallory" }, { version: "2.0.1" }])(
    "correlates reordered batches and fails closed on identity mismatch %j",
    async (mismatch) => {
      batch([verdict(target("calendar", "bob", "2.0.0"), mismatch), verdict(target())]);

      const items = await fetchExactClawHubSkillSecurityVerdicts({
        items: [target(), target("calendar", "bob", "2.0.0")],
        skipAuth: true,
      });

      expect(items).toMatchObject([
        { ok: true, requestedOwnerHandle: "alice", publisherHandle: "alice" },
        {
          ok: false,
          requestedOwnerHandle: "bob",
          requestedVersion: "2.0.0",
          reasons: ["security.identity_mismatch"],
          error: { code: "identity_mismatch" },
        },
      ]);
      expect(mocks.fetchClawHubSkillVerification).not.toHaveBeenCalled();
    },
  );
});
