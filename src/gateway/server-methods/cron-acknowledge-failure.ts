import {
  ErrorCodes,
  errorShape,
  validateCronAcknowledgeFailureParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  CRON_FAILURE_DISMISSALS_KEY,
  cronFailureTimestamp,
} from "../../../packages/gateway-protocol/src/schema/cron-failure-dismissals.js";
import { setCanonicalUserPreferences } from "../../state/user-preferences.js";
import { scopedCronJobHandler } from "./cron-job-access.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";
import { prepareAuthenticatedProfile, preparePersonalPreferences } from "./users-profile-access.js";

export const cronAcknowledgeFailureHandler = scopedCronJobHandler(
  "cron.acknowledgeFailure",
  validateCronAcknowledgeFailureParams,
  async (options, { jobId, job }) => {
    const failedAtMs = cronFailureTimestamp(job);
    const adopt = "adopt" in options.params;
    const assertPersonal = preparePersonalPreferences(options.client);
    const profile = await prepareAuthenticatedProfile(options);
    profile.assertCurrent();
    if (!profile.profileId) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "An operator profile is required"),
      );
      return;
    }
    if ("failedAtMs" in options.params && options.params.failedAtMs !== failedAtMs) {
      options.respond(true, { acknowledgedAtMs: null }, undefined);
      return;
    }
    const result = await setCanonicalUserPreferences(
      profile.profileId,
      {},
      {
        assertCurrent: () => {
          profile.assertCurrent();
          assertPersonal();
        },
        // A v2 ID may arrive after recovery. Mark its history as imported once so
        // another old browser cannot hide a failure that happens after this visit.
        cronFailure: { jobId, failedAtMs: failedAtMs ?? job.state.lastRunAtMs ?? 0, adopt },
      },
    );
    if (!result?.ok) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Could not save the automation dismissal"),
      );
      return;
    }
    options.respond(true, { acknowledgedAtMs: result.value.acknowledgedAtMs }, undefined);
    publishUserPreferencesChanged(options.context, result.value.profileId, [
      CRON_FAILURE_DISMISSALS_KEY,
    ]);
  },
  { allowCurrentJob: true, checkVisibility: true },
);
