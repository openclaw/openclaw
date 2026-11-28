import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createSessionObserverCompletion,
  SessionObserverOwnerRefusal,
} from "./session-observer-completion.js";
import { observerState } from "./session-observer-state.test-support.js";
import { modelMessage, preparedModel } from "./session-observer.test-utils.js";

let testState: OpenClawTestState;
beforeEach(async () => {
  testState = await createOpenClawTestState({ scenario: "minimal" });
});
afterEach(async () => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  await testState.cleanup();
});

it.each([
  { allow: ["test/main"], attempts: 0 },
  { allow: ["test/main", "test/utility"], attempts: 1 },
])(
  "decides observation by the session owner's role (allow $allow)",
  async ({ allow, attempts }) => {
    // The persisted digest reaches every viewer, so the owner's role applies.
    const profile = await ensureCanonicalUserProfileForEmail("observer-owner@example.test");
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "test/main", utilityModel: "test/utility" } },
      gateway: {
        roles: {
          default: "member",
          definitions: {
            member: {
              agents: "*",
              scopes: ["operator.read", "operator.write"],
              sessions: { others: "none" },
              modelPolicy: { allow },
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const prepareModel = vi.fn(async () => preparedModel());
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Working", health: "on-track" }),
    );
    const complete = createSessionObserverCompletion({
      getConfig: () => cfg,
      prepareModel,
      completeModel,
      isCurrent: () => true,
      readEntry: async () => ({
        sessionId: "session-id",
        updatedAt: 0,
        createdActor: { type: "human", source: "profile", id: profile.id },
      }),
    });
    const state = observerState({ utilityModelRef: "test/utility" });
    const digest = complete(state, ["Edited the parser."]);
    if (attempts === 0) {
      await expect(digest).rejects.toBeInstanceOf(SessionObserverOwnerRefusal);
    } else {
      await expect(digest).resolves.toMatchObject({ headline: "Working" });
    }
    expect(completeModel).toHaveBeenCalledTimes(attempts);
    if (attempts) {
      expect(completeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          operatorAuthority: expect.objectContaining({ profileId: profile.id }),
        }),
      );
    }
  },
);
