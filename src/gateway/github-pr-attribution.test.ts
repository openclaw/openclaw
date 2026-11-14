// Install transport fixtures before loading publication owners.
// oxfmt-ignore
import { githubPublicationTestMocks, installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  PR_ATTRIBUTION_FOOTER,
  PR_ATTRIBUTION_PREFERENCE_KEY,
  GIT_COAUTHOR_PREFERENCE_KEY,
} from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { preparePrAttribution } from "../agents/pr-attribution.js";
import * as userPreferences from "../state/user-preferences.js";
import { setUserPreferences } from "../state/user-preferences.test-support.js";
import { createRequesterPublicationFixture } from "./github-publication-requester.test-support.js";

const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./worker-environments/session-repository-checkpoints.js")
  >()),
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const mocks = githubPublicationTestMocks();
function setPreference(profileId: string, value: boolean | string, disableCoauthor = false) {
  expect(
    setUserPreferences(profileId, {
      [PR_ATTRIBUTION_PREFERENCE_KEY]: value,
      ...(disableCoauthor ? { [GIT_COAUTHOR_PREFERENCE_KEY]: false } : {}),
    }).ok,
  ).toBe(true);
}
const attribution = async (params: Parameters<typeof preparePrAttribution>[0]) =>
  (await preparePrAttribution(params))();

describe("managed PR attribution", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });
  it("omits optional branding when its preference cannot be read", async () => {
    using _ = vi
      .spyOn(userPreferences, "getUserPreferenceValues")
      .mockRejectedValueOnce(new Error("Preference storage unavailable"));
    expect(await attribution({ requesterProfileId: "unavailable-profile" })).toBe(false);
  });
  it("never uses an enabled person in incognito or without a verified requester", async () => {
    const f = await createRequesterPublicationFixture(checkpoint, "local");
    setPreference(f.guestProfile, true);
    const requesterProfileId = f.guestProfile;
    expect(await attribution({ requesterProfileId })).toBe(true);
    expect(await attribution({ requesterProfileId, incognito: true })).toBe(false);
    expect(
      await attribution({
        requesterProfileId,
        sessionKey: "agent:main:dashboard:incognito-private",
      }),
    ).toBe(false);
    expect(await attribution({})).toBe(false);
  });
  it.each([
    ["local", "missing"],
    ["local", "off"],
    ["local", "on"],
    ["local", "malformed"],
    ["local", "optout"],
    ["local", "existing-footer"],
    ["local", "other-requester"],
    ["local", "revoked"],
    ["repository", "on"],
    ["repository", "revoked"],
    ["repository", "existing-footer"],
  ] as const)("%s creation honors %s requester preference", async (backend, state) => {
    const f = await createRequesterPublicationFixture(checkpoint, backend);
    if (state !== "missing") {
      setPreference(f.guestProfile, state === "malformed" ? "true" : state !== "off", true);
    }
    const inputBody =
      "Keep human credit and work-session links." +
      (state === "optout" ? "\n\n<!-- openclaw:attribution=off -->" : "") +
      (state === "existing-footer" ? `\n\n${PR_ATTRIBUTION_FOOTER}` : "");
    const transport = mocks.runCommand.getMockImplementation()!;
    const postedBodies: string[] = [];
    mocks.runCommand.mockImplementation(async (argv, options) => {
      if (argv.includes("POST") && argv.some((arg: string) => arg.endsWith("/pulls"))) {
        postedBodies.push(JSON.parse(options!.input!).body);
      }
      const reply = await transport(argv, options);
      if (state === "revoked" && (argv.includes("push") || argv.includes("graphql"))) {
        setPreference(f.guestProfile, false);
      }
      return reply;
    });
    const request = {
      ...f.request(`attribution-${state}`, state === "other-requester" ? f.maintainer : f.guest),
      body: inputBody,
    };
    const result = await f.coordinator.requestForSessionV2(request);
    expect(result.status).toBe("published");
    const body = postedBodies.at(-1)!;
    expect(body).toContain("Keep human credit and work-session links.");
    expect(body).toContain(`<!-- openclaw-publication:${result.requestId} -->`);
    const enabled = state === "on" || state === "existing-footer";
    expect(body.split(PR_ATTRIBUTION_FOOTER).length - 1).toBe(enabled ? 1 : 0);
    if (state === "optout") {
      expect(body).toContain("<!-- openclaw:attribution=off -->");
    }
    if (state === "on") {
      // Replaying a published request must never repair a manually removed footer.
      const count = postedBodies.length;
      if (f.repository?.runtime.pr) {
        f.repository.runtime.pr.body = "Footer removed by the author.";
      }
      expect(await f.coordinator.requestForSessionV2(request)).toMatchObject({
        status: "published",
        requestId: result.requestId,
      });
      expect(postedBodies).toHaveLength(count);
      if (f.repository?.runtime.pr) {
        expect(f.repository.runtime.pr.body).toBe("Footer removed by the author.");
      }
    }
  });
});
