import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawStateReadOutcome } from "./openclaw-state-read.types.js";

const mocks = vi.hoisted(() => {
  const writableClosed = new Error("Writable SQLite actor admission is closed");
  return {
    writableClosed,
    write: vi.fn(async () => {
      throw writableClosed;
    }),
    read: vi.fn<() => Promise<OpenClawStateReadOutcome>>(),
    close: vi.fn(async () => undefined),
  };
});
vi.mock("./openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: mocks.write,
  runOpenClawStateWorkerOperation: mocks.write,
}));
vi.mock("./openclaw-state-read-worker.js", () => ({
  createOpenClawStateReadTransport: () => ({
    read: mocks.read,
    validateFresh: async () => {},
    close: mocks.close,
  }),
}));

import { createOnboardingRecommendationsStore } from "./onboarding-recommendations.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("reads independently while writable actor admission is closed", async () => {
  const root = tempDirs.make("onboarding-read-lifecycle-");
  const pathname = path.join(root, "state.sqlite");
  // The real source owner selects this file; the synthetic transport never opens SQLite.
  fs.writeFileSync(pathname, "synthetic reader source");
  const record = {
    inventoryHash: "synthetic-inventory",
    matches: [],
    offeredAt: 1,
    acceptedAt: null,
    updatedAt: 1,
  };
  mocks.read.mockResolvedValue({
    value: { ok: true, type: "onboardingRecommendations.read", sourceAdmitted: true, record },
  });
  const store = createOnboardingRecommendationsStore({
    workspaceDir: root,
    database: { path: pathname, env: { OPENCLAW_STATE_DIR: root } },
  });

  await expect(store.clear()).rejects.toBe(mocks.writableClosed);
  await expect(store.read()).resolves.toEqual(record);

  expect(mocks.write).toHaveBeenCalledOnce();
  expect(mocks.read).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(fs.readFileSync(pathname, "utf8")).toBe("synthetic reader source");
});
