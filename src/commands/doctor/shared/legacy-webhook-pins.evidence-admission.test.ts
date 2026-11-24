// Webhook installation evidence must wait out a transient schema lease, not fail startup.
import { expect, it, vi } from "vitest";
import {
  StateDatabaseAdmissionPendingError,
  StateDatabaseOfflineMaintenanceError,
} from "../../../infra/gateway-state-owner-record.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createHistoricalWebhookPinMigration } from "./legacy-webhook-pins.js";

const hook = vi.hoisted(() => ({ failures: [] as Error[] }));
vi.mock("../../../state/openclaw-state-db-readonly.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../state/openclaw-state-db-readonly.js")>();
  return {
    ...original,
    withExistingOpenClawStateDatabaseReadOnly: (
      ...args: Parameters<typeof original.withExistingOpenClawStateDatabaseReadOnly>
    ) => {
      const failure = hook.failures.shift();
      if (failure) {
        throw failure;
      }
      return original.withExistingOpenClawStateDatabaseReadOnly(...args);
    },
  };
});

it.each(["schema-lease", "offline-maintenance"] as const)(
  "handles a foreign %s held during the installation evidence read",
  async (holder) => {
    await withOpenClawTestState({ label: "webhook-evidence-admission" }, async (state) => {
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      const failure =
        holder === "schema-lease"
          ? new StateDatabaseAdmissionPendingError(databasePath, "schema lease held")
          : new StateDatabaseOfflineMaintenanceError(databasePath, "offline maintenance held");
      hook.failures = [failure, failure];
      const migrate = createHistoricalWebhookPinMigration(state.env);
      const run = () =>
        migrate({ config: {}, changes: [], historicalWebhookAccountIds: [undefined] }, {
          channelId: "telegram",
        } as Parameters<typeof migrate>[1]);
      if (holder === "schema-lease") {
        expect(run).not.toThrow();
        expect(hook.failures).toHaveLength(0);
      } else {
        expect(run).toThrow("offline maintenance held");
        expect(hook.failures).toHaveLength(1);
      }
      hook.failures = [];
    });
  },
);
