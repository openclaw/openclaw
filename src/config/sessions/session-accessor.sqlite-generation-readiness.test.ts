import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  resolveMemoryAudienceFromEntry,
  assertMemoryAudienceCurrent,
  prepareMemoryAudienceRead,
} from "../../plugins/memory-audience.js";
import { bindMemoryProvider } from "../../plugins/memory-provider-adapter.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "./session-entry-current-check.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

type Scope = { agentId: string; storePath: string; sessionKey: string };
type Entry = Parameters<typeof replaceSessionEntrySync>[1];

function seedSession(name: string, fields: Partial<Entry> = {}) {
  const scope = {
    agentId: "main",
    storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
    sessionKey: `agent:main:${name}`,
  };
  const original = {
    sessionId: "a1234567-1234-1234-1234-123456789abc",
    lifecycleRevision: "original-lifecycle",
    updatedAt: 1,
    ...fields,
  };
  replaceSessionEntrySync(scope, original);
  return { scope, original };
}

async function memoryGrant(scope: Scope, entry: Entry, senderIsOwner: boolean) {
  const grant = await resolveMemoryAudienceFromEntry(
    { ...scope, sessionId: entry.sessionId, senderIsOwner },
    entry,
  );
  if (grant.status !== "granted") {
    throw new Error(grant.reason);
  }
  return grant;
}

function replace(scope: Scope, entry: Entry) {
  return applySessionEntryExactReplacements({
    ...scope,
    sessionKeys: [scope.sessionKey],
    requireWriteSuccess: true,
    update: () => ({ result: undefined, replacements: [{ sessionKey: scope.sessionKey, entry }] }),
  });
}

function holdPublication(signal: AbortSignal) {
  const committed = createDeferred();
  const release = createDeferred();
  const onAbort = () => release.resolve();
  signal.addEventListener("abort", onAbort, { once: true });
  delivery.afterResult = async () => {
    committed.resolve();
    await release.promise;
  };
  return {
    committed,
    release,
    wait(write: Promise<unknown>, message: string) {
      return withinTest(awaitGateBeforeSettlement(committed.promise, write, message), signal);
    },
    close() {
      release.resolve();
      delivery.afterResult = undefined;
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function memoryProvider(scope: Scope, audience: Parameters<typeof assertMemoryAudienceCurrent>[0]) {
  const health = vi.fn(async () => ({ status: "ready" as const }));
  const provider = bindMemoryProvider(
    {
      capabilities: {
        sources: ["memory"],
        pagination: false,
        candidates: [],
        projectFilter: false,
      },
      health,
      search: async () => ({ hits: [] }),
      get: async () => ({ status: "not_found" }),
      close: async () => {},
    },
    "test",
    {
      authority: { kind: "session", sessionKey: scope.sessionKey, sandboxed: false, audience },
      assertCurrent: () => {},
    },
  );
  return { health, provider };
}

it.for(["assignment", "metadata"] as const)(
  "checks absent ID selection during held $0 publication",
  async (change, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { scope, original } = seedSession("id-publication-sibling", {
        sessionId: "id-publication-sibling",
      });
      const sessionId = "id-publication-target";
      const selected = await captureSessionEntryCurrentCheckAsyncInternal({
        agentId: scope.agentId,
        storePath: scope.storePath,
        sessionId,
        fields: ["inheritedToolDeny"],
        errorMessage: "ID selection changed",
      });
      expect(selected.entry).toBeUndefined();
      selected.source();
      const held = holdPublication(signal);
      const { release } = held;
      const pending = replace(
        scope,
        change === "assignment"
          ? { sessionId, lifecycleRevision: "created-lifecycle", updatedAt: 2 }
          : { ...original, label: "Harmless metadata", updatedAt: 2 },
      );
      try {
        await held.wait(pending, "ID write did not commit");
        if (change === "assignment") {
          expect(selected.source).toThrow("ID selection changed");
        } else {
          selected.source();
        }
        release.resolve();
        await withinTest(pending, signal);
        if (change === "assignment") {
          expect(selected.source).toThrow("ID selection changed");
        } else {
          selected.source();
        }
      } finally {
        held.close();
        await Promise.allSettled([pending]);
        selected.release();
      }
    });
  },
);

it.for(["permissionMode", "toolOverrides", "lifecycleRunId"] as const)(
  "keeps exec-wake settings available only when pending %s publication preserves policy",
  async (setting, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { scope, original } = seedSession("permission-readiness", {
        sessionId: "e1234567-1234-1234-1234-123456789abc",
        permissionMode: "full" as const,
        toolOverrides: { webSearch: true },
      });
      const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
      const settings = {
        permissionMode:
          setting === "permissionMode" ? ("read-only" as const) : original.permissionMode,
        toolOverrides: setting === "toolOverrides" ? { webSearch: false } : original.toolOverrides,
      };
      const held = holdPublication(signal);
      const { release } = held;
      const write = replace(scope, { ...original, ...settings, lifecycleRunId: "completion-wake" });
      try {
        await held.wait(write, "policy write did not commit");
        // Exec wakes check identity and settings synchronously after tool-preparation awaits.
        generation.assertCurrent();
        if (setting === "lifecycleRunId") {
          expect(generation.readSessionSettings()).toEqual(settings);
        } else {
          expect(generation.readSessionSettings).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
          );
        }
        release.resolve();
        await withinTest(write, signal);
        generation.assertCurrent();
        expect(generation.readSessionSettings()).toEqual(settings);
      } finally {
        held.close();
        await Promise.allSettled([write]);
        generation.release();
      }
    });
  },
);

it.for(["metadata", "replacement"] as const)(
  "joins admitted %s publication before checking the retained session generation",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { scope, original } = seedSession("generation-readiness", { chatType: "direct" });
      const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
      const releasedGeneration = await prepareSessionGenerationFacts({ ...scope, ...original });
      const grant = await memoryGrant(scope, original, true);
      const { health, provider } = memoryProvider(scope, grant.audience);
      const writes: Promise<unknown>[] = [];
      const readiness: Promise<unknown>[] = [];
      let held: ReturnType<typeof holdPublication> | undefined;
      const replaceLabel = (label: string) =>
        replace(scope, {
          ...original,
          label,
          updatedAt: 2,
          lifecycleRevision:
            kind === "replacement" ? "replacement-lifecycle" : original.lifecycleRevision,
        });
      try {
        for (const round of kind === "metadata" ? [0, 1] : [0]) {
          held = holdPublication(signal);
          const write = replaceLabel(`metadata-${round}`);
          writes.push(write);
          await held.wait(write, "replacement did not reach publication");
          // Synchronous reads stay available for an identity-preserving publication; a
          // replacement fences them. Prepared reads still join either publication.
          if (kind === "metadata") {
            generation.assertCurrent();
            assertMemoryAudienceCurrent(grant.audience);
          } else {
            expect(generation.assertCurrent).toThrow(
              expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
            );
            expect(() => assertMemoryAudienceCurrent(grant.audience)).toThrow(
              "currency is unavailable",
            );
          }
          const priorCalls = health.mock.calls.length;
          const providerRead = provider.health().catch((error: unknown) => error);
          readiness.push(providerRead);
          expect(health).toHaveBeenCalledTimes(priorCalls);
          const pending = generation.prepareRead();
          expect(pending).toBeInstanceOf(Promise);
          if (!pending) {
            throw new Error("The admitted replacement must expose publication completion");
          }
          readiness.push(pending);
          let prepared = false;
          void pending.then(
            () => {
              prepared = true;
            },
            () => {},
          );
          let releasedRead: Promise<unknown> | undefined;
          if (round === 0) {
            releasedRead = releasedGeneration.prepareRead()?.catch((error: unknown) => error);
            expect(releasedRead).toBeInstanceOf(Promise);
            if (releasedRead) {
              readiness.push(releasedRead);
            }
            releasedGeneration.release();
          }
          await Promise.resolve();
          expect(prepared).toBe(false);
          held.release.resolve();
          await withinTest(write, signal);
          await withinTest(pending, signal);
          if (releasedRead) {
            await expect(releasedRead).resolves.toMatchObject({
              code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE",
            });
          }
          expect(generation.prepareRead()).toBeUndefined();
          if (kind === "replacement") {
            expect(() => assertMemoryAudienceCurrent(grant.audience)).toThrow("no longer current");
            expect(await providerRead).toBeInstanceOf(Error);
            expect(health).toHaveBeenCalledTimes(priorCalls);
            expect(generation.assertCurrent).toThrow(
              expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
            );
          } else {
            await expect(providerRead).resolves.toEqual({ status: "ready" });
            expect(health).toHaveBeenCalledTimes(priorCalls + 1);
            generation.assertCurrent();
            assertMemoryAudienceCurrent(grant.audience);
          }
          held.close();
        }
        delivery.afterResult = undefined;
        if (kind === "metadata") {
          // A queued successor has not published an admission and cannot make its owner wait.
          let successor: Promise<unknown> | undefined;
          await runOpenClawAgentWriteAdmission(
            { agentId: scope.agentId, path: scope.storePath },
            () => {
              successor = replaceLabel("queued-successor");
              writes.push(successor);
              expect(generation.prepareRead()).toBeUndefined();
              generation.assertCurrent();
            },
          );
          if (!successor) {
            throw new Error("The admitted owner must start its queued successor");
          }
          await withinTest(successor, signal);
          generation.assertCurrent();
        }
      } finally {
        held?.close();
        await Promise.allSettled([...writes, ...readiness]);
        releasedGeneration.release();
        generation.release();
        grant.release();
        await provider.close();
      }
    });
  },
);

it.for(["metadata", "reset"] as const)(
  "waits on a parent %s publication before a retained child audience reaches the provider",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { scope: parentScope, original: parent } = seedSession("generation-parent", {
        sessionId: "b1234567-1234-1234-1234-123456789abc",
        chatType: "direct" as const,
        lifecycleRevision: "parent-lifecycle",
      });
      const { scope: childScope, original: child } = seedSession("subagent:generation-child", {
        sessionId: "c1234567-1234-1234-1234-123456789abc",
        lifecycleRevision: "child-lifecycle",
        spawnedBy: parentScope.sessionKey,
        spawnedBySessionId: parent.sessionId,
        spawnedBySenderIsOwner: true,
        parentSessionLifecycleRevision: parent.lifecycleRevision,
      });
      // The child's audience is minted through the real lineage walk and leases its parent.
      const grant = await memoryGrant(childScope, child, false);
      const { health, provider } = memoryProvider(childScope, grant.audience);
      const held = holdPublication(signal);
      const { release } = held;
      // Hold the parent publication mid-flight; a reset keeps the session id but changes its revision.
      const reset = replace(parentScope, {
        ...parent,
        label: "parent-metadata",
        lifecycleRevision: kind === "reset" ? "parent-reset-lifecycle" : parent.lifecycleRevision,
        updatedAt: 2,
      });
      try {
        await held.wait(reset, "parent reset did not reach publication");
        // The child audience waits on its parent's admitted publication instead of failing.
        const waiting = prepareMemoryAudienceRead(grant.audience)?.then(
          () => "current",
          (error: unknown) => error,
        );
        expect(waiting).toBeInstanceOf(Promise);
        if (kind === "metadata") {
          assertMemoryAudienceCurrent(grant.audience);
        }
        const providerRead = provider.health().catch((error: unknown) => error);
        expect(health).not.toHaveBeenCalled();
        release.resolve();
        await withinTest(reset, signal);
        if (kind === "reset") {
          expect(await waiting).toBeInstanceOf(Error);
          expect(await providerRead).toBeInstanceOf(Error);
          expect(health).not.toHaveBeenCalled();
          expect(() => assertMemoryAudienceCurrent(grant.audience)).toThrow("no longer current");
        } else {
          await expect(waiting).resolves.toBe("current");
          await expect(providerRead).resolves.toEqual({ status: "ready" });
          expect(health).toHaveBeenCalledTimes(1);
          assertMemoryAudienceCurrent(grant.audience);
        }
      } finally {
        held.close();
        await Promise.allSettled([reset]);
        grant.release();
        await provider.close();
      }
    });
  },
);
