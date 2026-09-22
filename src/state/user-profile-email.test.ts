import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { ensureProfileIdForEmail } from "./user-profile-email.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { readResidentUserProfileId, retainUserProfileCatalog } from "./user-profile-list.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({ afterResult: undefined as (() => void) | undefined }));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "userProfiles.ensureEmail") {
                delivery.afterResult?.();
              }
              return result;
            },
          }),
        options,
      ),
  };
});
afterEach(() => {
  delivery.afterResult = undefined;
});

it("publishes a created email profile after lost result delivery while its database closes", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const pathname = openOpenClawStateDatabase().path;
    const release = retainUserProfileCatalog();
    let closing: ReturnType<typeof closeOpenClawStateDatabaseByPathAsync> | undefined;
    try {
      const before = readUserProfileVersion();
      delivery.afterResult = () => {
        closing = closeOpenClawStateDatabaseByPathAsync(pathname);
        throw new Error("synthetic profile result loss");
      };
      await expect(ensureProfileIdForEmail("new@example.test")).rejects.toThrow(
        "synthetic profile result loss",
      );
      await closing;
      const profile = ensureProfileForEmail("new@example.test");
      expect(readResidentUserProfileId(profile.id)).toBe(profile.id);
      expect(readUserProfileVersion()).toBe(before + 1);
    } finally {
      await closing;
      release();
    }
  });
});
