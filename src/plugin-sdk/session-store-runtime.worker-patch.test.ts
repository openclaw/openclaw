import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture } from "../config/sessions/session-compound-worker.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applySessionEntryPatch,
  prepareSessionEntryPatch,
  updateLastRouteWithAuthority,
} from "./session-store-runtime.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();

it("rejects an unprepared JavaScript source capability before invoking it or opening storage", async () => {
  const source = vi.fn();
  const prepare = vi.fn();
  const params = {
    sessionKey: "agent:main:invalid-source",
    storePath: "invalid-source-must-not-open.sqlite",
    authority: { kind: "source" as const, source },
  };
  const error = "Session entry source authority requires a prepared source capability";
  await expect(
    Reflect.apply(prepareSessionEntryPatch, undefined, [{ ...params, prepare }]),
  ).rejects.toThrow(error);
  await expect(
    Reflect.apply(applySessionEntryPatch, undefined, [{ ...params, patch: { label: "refused" } }]),
  ).rejects.toThrow(error);
  expect(() => Reflect.apply(updateLastRouteWithAuthority, undefined, [params])).toThrow(error);
  expect(source).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(delivery.commands).toEqual([]);
});

it("commits a public conditional patch in the worker and rejects a replaced generation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createSessionCompoundWorkerFixture();
    const original = fixture.read()!;
    const updated = await applySessionEntryPatch({
      ...fixture.scope,
      expected: { sessionId: original.sessionId },
      patch: { label: "worker patch" },
      preserveActivity: true,
      skipMaintenance: true,
    });
    expect(updated).toMatchObject({ sessionId: original.sessionId, label: "worker patch" });
    expect(fixture.read()).toMatchObject({
      sessionId: original.sessionId,
      label: "worker patch",
      updatedAt: original.updatedAt,
    });
    expect(delivery.commands).toEqual(["session.entry.patch.commit"]);

    const absentScope = { ...fixture.scope, sessionKey: "agent:main:missing" };
    const fallbackEntry = { sessionId: "missing-session", updatedAt: 1 };
    await expect(
      applySessionEntryPatch({
        ...absentScope,
        expected: { sessionId: fallbackEntry.sessionId },
        fallbackEntry,
        patch: { label: "must remain absent" },
        skipMaintenance: true,
      }),
    ).rejects.toThrow("Session entry changed before the conditional patch committed");
    const created = await applySessionEntryPatch({
      ...absentScope,
      expected: null,
      fallbackEntry,
      patch: { label: "create once" },
      skipMaintenance: true,
    });
    expect(created).toMatchObject({ sessionId: fallbackEntry.sessionId, label: "create once" });
    await expect(
      applySessionEntryPatch({
        ...absentScope,
        expected: null,
        fallbackEntry,
        patch: { label: "must not overwrite" },
        skipMaintenance: true,
      }),
    ).rejects.toThrow("Session entry changed before the conditional patch committed");

    const beforeCommit = vi.fn(() => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(fixture.scope, { ...original, sessionId: "successor" });
    });
    delivery.beforeCommit = beforeCommit;
    await expect(
      applySessionEntryPatch({
        ...fixture.scope,
        expected: { sessionId: original.sessionId },
        patch: { label: "must not persist" },
        skipMaintenance: true,
      }),
    ).rejects.toThrow("Session entry changed before the conditional patch committed");
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(fixture.read()).toMatchObject({ sessionId: "successor" });
    expect(fixture.read()?.label).not.toBe("must not persist");
  });
});

it("prepares once outside the transaction and rejects a changed snapshot without replay", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createSessionCompoundWorkerFixture();
    const original = fixture.read()!;
    const prepare = vi.fn(async () => ({ label: "must not persist" }));
    const beforeCommit = vi.fn(() => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(fixture.scope, { ...original, label: "concurrent write" });
    });
    delivery.beforeCommit = beforeCommit;
    await expect(
      prepareSessionEntryPatch({
        ...fixture.scope,
        prepare,
        skipMaintenance: true,
      }),
    ).rejects.toThrow(/changed/);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(delivery.commands).toEqual([
      "session.entry.patch.prepare",
      "session.entry.patch.commit",
    ]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(fixture.read()?.label).toBe("concurrent write");
  });
});

it("rechecks host authority at worker admission after preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createSessionCompoundWorkerFixture();
    const original = fixture.read()!;
    let current = true;
    const prepare = vi.fn(async () => ({ label: "must not persist" }));
    const beforeCommit = vi.fn(() => {
      current = false;
    });
    delivery.beforeCommit = beforeCommit;
    await expect(
      prepareSessionEntryPatch({
        ...fixture.scope,
        prepare,
        skipMaintenance: true,
        authority: {
          kind: "host",
          assertCurrent() {
            if (!current) {
              throw new Error("Session operation revoked");
            }
          },
        },
      }),
    ).rejects.toThrow("Session operation revoked");
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(delivery.commands).toEqual([
      "session.entry.patch.prepare",
      "session.entry.patch.commit",
    ]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(fixture.read()).toEqual(original);
  });
});
