import { expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import type { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import { acceptedWorktreeSession } from "./draft-worktree-submission.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";
import { loadNewSessionPreference } from "./preferences.ts";

type Fixture = ReturnType<typeof createDraftFixture>;
export const browserPreference = () => loadNewSessionPreference("ws://gateway.example", "main");
export const acceptedNameWarning = {
  message:
    "Session accepted, but clearing the saved worktree name could not be confirmed. Check Name before starting another worktree.",
};

export function resetWorktreeMocks() {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
}

export function startAcceptedWorktree(fixture: Fixture, detached = true) {
  vi.mocked(fixture.context.sessions.createResult).mockResolvedValue(acceptedWorktreeSession);
  fixture.flow.setMessage("first task");
  return fixture.flow.submit(undefined, detached);
}

export function preferenceGate() {
  const started = createDeferred();
  const release = createDeferred();
  return {
    started,
    release,
    wait: async () => {
      started.resolve();
      await release.promise;
    },
  };
}

export function expectWorktreeName(place: Fixture["place"], name = "") {
  expect(place.worktreeName).toBe(name);
  expect(browserPreference()?.worktreeName).toBe(name || undefined);
}

export function holdPreferenceClear(
  prefs: ReturnType<typeof identityPreferences>,
  once = false,
  gate = { started: createDeferred(), release: createDeferred() },
) {
  const { started, release } = gate;
  let held = false;
  prefs.beforeSave.mockImplementation(async ({ entries }) => {
    const entry = entries["new-session.v1:main"];
    if (
      (!once || !held) &&
      entry &&
      typeof entry === "object" &&
      "worktreeName" in entry &&
      entry.worktreeName === ""
    ) {
      held = true;
      started.resolve();
      await release.promise;
    }
  });
  return { started, release };
}

export function acceptIdlePlacement(fixture: Fixture) {
  vi.mocked(fixture.context.sessions.createResult).mockImplementation(async (params) => ({
    key: params!.key!,
    initialRun: { status: "idle" },
  }));
}

export async function chooseModel(fixture: Fixture, model = "openai/gpt-5.6-sol") {
  const option = () =>
    renderControl(fixture.place.modelControl, fixture.context).querySelector<HTMLButtonElement>(
      `[data-chat-model-option="${model}"]`,
    );
  await vi.waitFor(() => expect(option()).not.toBeNull());
  option()!.click();
}
