import { expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import type { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import type { identityPreferences } from "./draft-worktree-preferences.test-support.ts";

type Fixture = ReturnType<typeof createDraftFixture>;

export const acceptedWorktreeSession = {
  key: "agent:main:dashboard:first",
  initialRun: { status: "started", runId: "first-run" },
} satisfies SessionCreateOutcome;

export async function readyPreferenceDraft(
  prefs: ReturnType<typeof identityPreferences>,
  gateway?: Fixture["context"]["gateway"],
) {
  const fixture = prefs.make(gateway);
  await prefs.ready(fixture);
  return fixture;
}

export async function submitPendingWorktree(fixture: Fixture) {
  const admitted = createDeferred<SessionCreateOutcome>();
  vi.mocked(fixture.context.sessions.createResult).mockReturnValue(admitted.promise);
  fixture.flow.setMessage("first task");
  const submitting = fixture.flow.submit(undefined, true);
  await vi.waitFor(() => expect(fixture.context.sessions.createResult).toHaveBeenCalledOnce());
  return { admitted, submitting };
}

export function disposeWorktreeDraft(fixture: Fixture) {
  fixture.gateway.disconnect();
  fixture.place.browser.disconnect();
  fixture.flow.disconnect();
}

export function selectCloudWorktree(fixture: Pick<Fixture, "gateway" | "place">) {
  vi.spyOn(fixture.gateway, "cloudProfiles", "get").mockReturnValue([
    { id: "cloud", providerId: "crabbox", executionModes: ["worker-turn", "remote-exec"] },
  ]);
  vi.spyOn(fixture.gateway, "cloudProfilesReady", "get").mockReturnValue(true);
  vi.spyOn(fixture.gateway, "cloudProfilesPending", "get").mockReturnValue(false);
  fixture.place.selectCloudProfile("cloud");
}
