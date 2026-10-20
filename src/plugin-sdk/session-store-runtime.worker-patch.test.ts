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
const changed = "Session entry changed before the conditional patch committed";
const withFixture = (
  run: (fixture: ReturnType<typeof createSessionCompoundWorkerFixture>) => Promise<void>,
) =>
  withOpenClawTestState({ scenario: "minimal" }, async () =>
    run(createSessionCompoundWorkerFixture()),
  );
const preparePatch = (
  fixture: ReturnType<typeof createSessionCompoundWorkerFixture>,
  prepare: Parameters<typeof prepareSessionEntryPatch>[0]["prepare"],
  authority?: Parameters<typeof prepareSessionEntryPatch>[0]["authority"],
) => prepareSessionEntryPatch({ ...fixture.scope, prepare, authority, skipMaintenance: true });

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
  await withFixture(async (fixture) => {
    const original = fixture.read()!;
    const patch = (
      label: string,
      options: Partial<Parameters<typeof applySessionEntryPatch>[0]> = {},
    ) =>
      applySessionEntryPatch({
        ...fixture.scope,
        expected: { sessionId: original.sessionId },
        patch: { label },
        skipMaintenance: true,
        ...options,
      });
    const updated = await patch("worker patch", { preserveActivity: true });
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
      patch("must remain absent", {
        ...absentScope,
        expected: { sessionId: fallbackEntry.sessionId },
        fallbackEntry,
      }),
    ).rejects.toThrow(changed);
    const created = await patch("create once", {
      ...absentScope,
      expected: null,
      fallbackEntry,
    });
    expect(created).toMatchObject({ sessionId: fallbackEntry.sessionId, label: "create once" });
    await expect(
      patch("must not overwrite", {
        ...absentScope,
        expected: null,
        fallbackEntry,
      }),
    ).rejects.toThrow(changed);

    const beforeCommit = vi.fn(() => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(fixture.scope, { ...original, sessionId: "successor" });
    });
    delivery.beforeCommit = beforeCommit;
    await expect(patch("must not persist")).rejects.toThrow(changed);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(fixture.read()).toMatchObject({ sessionId: "successor" });
    expect(fixture.read()?.label).not.toBe("must not persist");
  });
});

it("prepares once outside the transaction and rejects a changed snapshot without replay", async () => {
  await withFixture(async (fixture) => {
    const original = fixture.read()!;
    const prepare = vi.fn(async () => ({ label: "must not persist" }));
    const beforeCommit = vi.fn(() => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(fixture.scope, { ...original, label: "concurrent write" });
    });
    delivery.beforeCommit = beforeCommit;
    await expect(preparePatch(fixture, prepare)).rejects.toThrow(/changed/);
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
  await withFixture(async (fixture) => {
    const original = fixture.read()!;
    let current = true;
    const prepare = vi.fn(async () => ({ label: "must not persist" }));
    const beforeCommit = vi.fn(() => {
      current = false;
    });
    delivery.beforeCommit = beforeCommit;
    await expect(
      preparePatch(fixture, prepare, {
        kind: "host",
        assertCurrent() {
          if (!current) {
            throw new Error("Session operation revoked");
          }
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
