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

describe("managed PR attribution", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });
  it("omits optional branding when its preference cannot be read", async () => {
    const read = vi
      .spyOn(userPreferences, "getUserPreferenceValues")
      .mockRejectedValueOnce(new Error("Preference storage unavailable"));
    try {
      expect((await preparePrAttribution({ requesterProfileId: "unavailable-profile" }))()).toBe(
        false,
      );
    } finally {
      read.mockRestore();
    }
  });
  it("never uses an enabled person in incognito or without a verified requester", async () => {
    const f = await createRequesterPublicationFixture(checkpoint, "local");
    expect(setUserPreferences(f.guestProfile, { [PR_ATTRIBUTION_PREFERENCE_KEY]: true }).ok).toBe(
      true,
    );
    expect((await preparePrAttribution({ requesterProfileId: f.guestProfile }))()).toBe(true);
    expect(
      (await preparePrAttribution({ requesterProfileId: f.guestProfile, incognito: true }))(),
    ).toBe(false);
    expect(
      (
        await preparePrAttribution({
          requesterProfileId: f.guestProfile,
          sessionKey: "agent:main:dashboard:incognito-private",
        })
      )(),
    ).toBe(false);
    expect((await preparePrAttribution({}))()).toBe(false);
  });
  it.each(
    (["local", "repository"] as const).flatMap((backend) =>
      [
        "missing",
        "off",
        "on",
        "malformed",
        "optout",
        "existing-footer",
        "other-requester",
        "revoked",
      ].map((state) => ({ backend, state })),
    ),
  )("$backend creation honors $state requester preference", async ({ backend, state }) => {
    const f = await createRequesterPublicationFixture(checkpoint, backend);
    if (state !== "missing") {
      expect(
        setUserPreferences(f.guestProfile, {
          [PR_ATTRIBUTION_PREFERENCE_KEY]: state === "malformed" ? "true" : state !== "off",
          [GIT_COAUTHOR_PREFERENCE_KEY]: false,
        }).ok,
      ).toBe(true);
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
        expect(
          setUserPreferences(f.guestProfile, { [PR_ATTRIBUTION_PREFERENCE_KEY]: false }).ok,
        ).toBe(true);
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
