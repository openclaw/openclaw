import { describe, expect, it } from "vitest";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createQueueTestRun,
  createQueueSettings,
  createDrainRecorder,
} from "./queue.test-helpers.js";

describe("personal bootstrap in collected turns", () => {
  it.each(["same", "different", "unknown", "merged"] as const)(
    "selects personal context only for one canonical person: %s",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const alice = ensureProfileForEmail("alice@example.test");
        const bob = ensureProfileForEmail("bob@example.test");
        const key = "personal-bootstrap-collect";
        const { calls, done, runFollowup } = createDrainRecorder();
        const settings = createQueueSettings();
        const second = kind === "same" ? alice.id : kind === "unknown" ? undefined : bob.id;
        for (const profileId of [alice.id, second]) {
          const run = createQueueTestRun({
            prompt: "queued message",
            originatingChannel: "slack",
            originatingTo: "channel:A",
          });
          run.run.bootstrapUserProfileId = profileId;
          enqueueFollowupRun(key, run, settings);
        }
        if (kind === "merged") {
          linkEmail("alice@example.test", bob.id);
        }
        scheduleFollowupDrain(key, runFollowup);
        await done.promise;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.run.bootstrapUserProfileId).toBe(
          kind === "same" ? alice.id : kind === "merged" ? bob.id : undefined,
        );
      });
    },
  );
});
