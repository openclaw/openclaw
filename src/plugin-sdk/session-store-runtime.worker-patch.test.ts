import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture } from "../config/sessions/session-compound-worker.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applySessionEntryPatch as applyPatch,
  prepareSessionEntryPatch as prepareEntry,
  updateLastRouteWithAuthority as updateRoute,
} from "./session-store-runtime.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();
const changed = "Session entry changed before the conditional patch committed";
type Fixture = ReturnType<typeof createSessionCompoundWorkerFixture>;
const withFixture = (run: (fixture: Fixture) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async () =>
    run(createSessionCompoundWorkerFixture()),
  );
const preparePatch = (
  fixture: Fixture,
  prepare: Parameters<typeof prepareEntry>[0]["prepare"],
  authority?: Parameters<typeof prepareEntry>[0]["authority"],
) => prepareEntry({ ...fixture.scope, prepare, authority, skipMaintenance: true });

it("rejects an unprepared JavaScript source capability before invoking it or opening storage", async () => {
  const source = vi.fn();
  const prepare = vi.fn();
  const params = {
    sessionKey: "agent:main:invalid-source",
    storePath: "invalid-source-must-not-open.sqlite",
    authority: { kind: "source" as const, source },
  };
  const error = "Session entry source authority requires a prepared source capability";
  await expect(Reflect.apply(prepareEntry, undefined, [{ ...params, prepare }])).rejects.toThrow(
    error,
  );
  await expect(
    Reflect.apply(applyPatch, undefined, [{ ...params, patch: { label: "refused" } }]),
  ).rejects.toThrow(error);
  expect(() => Reflect.apply(updateRoute, undefined, [params])).toThrow(error);
  expect(source).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(delivery.commands).toEqual([]);
});

it("commits a public conditional patch in the worker and rejects a replaced generation", async () => {
  await withFixture(async (fixture) => {
    const original = fixture.read()!;
    const patch = (label: string, options: Partial<Parameters<typeof applyPatch>[0]> = {}) =>
      applyPatch({
        ...fixture.scope,
        expected: { sessionId: original.sessionId },
        patch: { label },
        skipMaintenance: true,
        ...options,
      });
    const skillsSnapshot = { prompt: "Synthetic instructions", skills: [{ name: "synthetic" }] };
    await patch("warm", { patch: { skillsSnapshot }, preserveActivity: true });
    const updated = await patch("worker patch", { preserveActivity: true });
    const expected = { sessionId: original.sessionId, label: "worker patch" };
    expect(updated).toMatchObject(expected);
    expect(fixture.read()).toMatchObject({ ...expected, updatedAt: original.updatedAt });
    expect(delivery.commands).toEqual(["session.entry.patch.commit", "session.entry.patch.commit"]);
    updated!.skillsSnapshot!.prompt = "Plugin-owned instructions";
    updated!.skillsSnapshot!.skills.push({ name: "plugin-owned" });
    expect(fixture.read()?.skillsSnapshot).toEqual(skillsSnapshot);

    const fallbackEntry = { sessionId: "missing", updatedAt: 1 };
    const missingPatch = (label: string, condition: { sessionId: string } | null) =>
      patch(label, { sessionKey: "agent:main:missing", fallbackEntry, expected: condition });
    await expect(
      missingPatch("must remain absent", { sessionId: fallbackEntry.sessionId }),
    ).rejects.toThrow(changed);
    const created = await missingPatch("create once", null);
    expect(created).toMatchObject({ sessionId: "missing", label: "create once" });
    await expect(missingPatch("must not overwrite", null)).rejects.toThrow(changed);

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

it.each(["snapshot", "authority"] as const)("rejects changed %s", async (change) => {
  await withFixture(async (fixture) => {
    const original = fixture.read()!;
    const prepare = vi.fn(async () => ({ label: "must not persist" }));
    const revoked = new AbortController();
    const beforeCommit = vi.fn(() => {
      delivery.beforeCommit = undefined;
      if (change === "snapshot") {
        replaceSessionEntrySync(fixture.scope, { ...original, label: "concurrent write" });
      } else {
        revoked.abort(new Error("Session operation revoked"));
      }
    });
    delivery.beforeCommit = beforeCommit;
    const authority =
      change === "authority"
        ? {
            kind: "host" as const,
            assertCurrent: () => revoked.signal.throwIfAborted(),
          }
        : undefined;
    await expect(preparePatch(fixture, prepare, authority)).rejects.toThrow(
      change === "snapshot" ? /changed/ : "Session operation revoked",
    );
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    if (change === "snapshot") {
      expect(fixture.read()?.label).toBe("concurrent write");
    } else {
      expect(fixture.read()).toEqual(original);
    }
  });
});
