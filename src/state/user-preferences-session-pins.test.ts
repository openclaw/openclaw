import { expect, it, vi } from "vitest";
import {
  UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY,
  UI_RAIL_SHORTCUTS_PREFERENCE_KEY,
} from "../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import * as stateWorker from "./openclaw-state-worker-store.js";
import { preparePersonalSessionPins } from "./user-preferences-session-pins.js";
import { setCanonicalUserPreferences } from "./user-preferences.js";
import { selectPersonalPinnedSessionKeys } from "./user-preferences.store.js";
import { setUserPreferences } from "./user-preferences.test-support.js";
import { mergeCanonicalUserProfiles } from "./user-profile-writes.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { useUserStateFixture } from "./user-state.test-support.js";

const stateOptions = useUserStateFixture("openclaw-personal-pin-retention-");

it("selects the union until the last profile removes its personal reference", () => {
  const options = stateOptions();
  const alice = ensureProfileForEmail("alice@example.test", options).id;
  const bob = ensureProfileForEmail("bob@example.test", options).id;
  const { db } = openOpenClawStateDatabase(options);
  const key = "agent:main:dashboard:keep";
  const pin = `session:${key}`;
  const read = () => selectPersonalPinnedSessionKeys(db);
  setUserPreferences(
    alice,
    {
      [UI_RAIL_SHORTCUTS_PREFERENCE_KEY]: [
        pin,
        pin,
        "session: agent:main:other ",
        "route:sessions",
        7,
      ],
      unrelated: ["session:agent:main:ignored"],
    },
    options,
  );
  setUserPreferences(
    bob,
    {
      [UI_RAIL_SHORTCUTS_PREFERENCE_KEY]: [pin, "person:alice"],
      [UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY]: [
        { id: "focus", label: "Focus", sessionKeys: [key, "agent:main:group"] },
      ],
    },
    options,
  );
  expect(read()).toEqual([key, "agent:main:group", "agent:main:other"]);

  setUserPreferences(alice, { [UI_RAIL_SHORTCUTS_PREFERENCE_KEY]: [] }, options);
  expect(read()).toEqual([key, "agent:main:group"]);
  setUserPreferences(bob, { [UI_RAIL_SHORTCUTS_PREFERENCE_KEY]: null }, options);
  expect(read()).toEqual([key, "agent:main:group"]);
  setUserPreferences(bob, { [UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY]: null }, options);
  expect(read()).toEqual([]);
});

it("shares one worker refresh after a preference change and retires a closed read source", async () => {
  const options = stateOptions();
  const profile = ensureProfileForEmail("reader@example.test", options).id;
  setUserPreferences(
    profile,
    { [UI_RAIL_SHORTCUTS_PREFERENCE_KEY]: ["session:agent:main:first"] },
    options,
  );
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const first = await preparePersonalSessionPins(options);
  setUserPreferences(
    profile,
    { [UI_RAIL_SHORTCUTS_PREFERENCE_KEY]: ["session:agent:main:second"] },
    options,
  );
  const refreshed = await Promise.all(
    Array.from({ length: 3 }, () => preparePersonalSessionPins(options)),
  );
  expect(read).toHaveBeenCalledTimes(2);
  for (const value of refreshed) {
    expect(value.sessionKeys).toEqual(["agent:main:second"]);
  }
  await closeOpenClawStateDatabaseByPathAsync(options.path);
  expect(() => first.isCurrent()).toThrow();
  const reopened = await preparePersonalSessionPins(options);
  expect(reopened.sessionKeys).toEqual(["agent:main:second"]);
  expect(read).toHaveBeenCalledTimes(3);
  await closeOpenClawStateDatabaseByPathAsync(options.path);
  const reopenedReadOnly = await preparePersonalSessionPins(options);
  expect(reopenedReadOnly.sessionKeys).toEqual(["agent:main:second"]);
  expect(read).toHaveBeenCalledTimes(4);
});

it.each([
  ["completed", UI_RAIL_SHORTCUTS_PREFERENCE_KEY],
  ["unknown", UI_RAIL_SHORTCUTS_PREFERENCE_KEY],
  ["completed", UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY],
  ["unknown", UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY],
] as const)(
  "keeps a queued %s native outcome ahead of %s pin changes",
  async (kind, preferenceKey) => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("queued@example.test", options).id;
    const pins = await preparePersonalSessionPins(options);
    const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
    const nativeStopped = createDeferredCore();
    pins.retainOperation({ settled: settled.promise, nativeStopped: nativeStopped.promise });
    const broker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockResolvedValueOnce(undefined);
    const writer = setCanonicalUserPreferences(
      profile,
      {
        [preferenceKey]:
          preferenceKey === UI_RAIL_SHORTCUTS_PREFERENCE_KEY
            ? ["session:agent:main:queued"]
            : [{ id: "focus", label: "Focus", sessionKeys: ["agent:main:queued"] }],
      },
      options,
    );
    expect(pins.isCurrent()).toBe(false);
    expect(broker).not.toHaveBeenCalled();
    settled.resolve(kind === "completed" ? { kind } : { kind, error: new Error("lost reply") });
    await settled.promise;
    if (kind === "unknown") {
      expect(broker).not.toHaveBeenCalled();
      nativeStopped.resolve();
    }
    await writer;
    expect(broker).toHaveBeenCalledTimes(1);
  },
);

it("invalidates cleanup before a profile merge waits for its read custody", async () => {
  const options = stateOptions();
  const source = ensureProfileForEmail("source@example.test", options).id;
  const target = ensureProfileForEmail("target@example.test", options).id;
  setUserPreferences(
    source,
    { [UI_RAIL_SHORTCUTS_PREFERENCE_KEY]: ["session:agent:main:merged"] },
    options,
  );
  const pins = await preparePersonalSessionPins(options);
  const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
  pins.retainOperation({ settled: settled.promise });
  const broker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockResolvedValueOnce({ ok: true, value: undefined });
  const merging = mergeCanonicalUserProfiles(source, target, options);
  expect(pins.isCurrent()).toBe(false);
  expect(broker).not.toHaveBeenCalled();
  settled.resolve({ kind: "completed" });
  await merging;
  expect(broker).toHaveBeenCalledTimes(1);
});
