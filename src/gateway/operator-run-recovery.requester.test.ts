import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { createRestartRecoveryRequesterSource } from "../agents/requester-run-recovery-source.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { restoreGatewayRunRecovery } from "./operator-run-recovery.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

describe("restart recovery requester custody", () => {
  it("restores only the requester bound to the current durable source claim", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("requester-custody@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
      });
      let current = true;
      const restore = async () =>
        (
          await restoreGatewayRunRecovery({
            target: fixture.target,
            context: fixture.context,
            restoreOperator: false,
            restoreRequester: true,
            assertCurrent: () => {
              if (!current) {
                throw new Error("recovery claim retired");
              }
            },
          })
        ).requesterOrigin;
      await expect(restore()).resolves.toBeUndefined();
      const origin = {
        sessionKey: "agent:research:telegram:group:requesters",
        messageProvider: "telegram",
        senderId: "bob",
      };
      const source = expectDefined(
        createRestartRecoveryRequesterSource({
          ...fixture.target,
          entry: fixture.entry,
          requesterOrigin: origin,
        }),
        "host-captured requester source",
      );
      const bound = { ...fixture.entry, restartRecoveryRequesterSource: source };
      await replaceSessionEntry(fixture.target, bound);
      origin.senderId = "alice";
      origin.sessionKey = "agent:research:telegram:group:replacement";
      await expect(restore()).resolves.toMatchObject({
        senderId: "bob",
        sessionKey: "agent:research:telegram:group:requesters",
      });
      const historical = structuredClone(source);
      Object.assign(historical.requesterOrigin, {
        senderIsOwner: true,
        conversationToolPolicy: { allow: ["*"] },
      });
      await replaceSessionEntry(fixture.target, {
        ...bound,
        restartRecoveryRequesterSource: historical,
      });
      const restoredFacts = await restore();
      expect(restoredFacts).not.toHaveProperty("senderIsOwner");
      expect(restoredFacts).not.toHaveProperty("conversationToolPolicy");
      for (const replacement of [
        { ...source, sessionId: "copied-session" },
        { ...source, sessionKey: "agent:main:copied" },
        { ...source, sourceRunId: "copied-run" },
        { ...source, lifecycleRevision: "replacement-lifecycle" },
      ]) {
        await replaceSessionEntry(fixture.target, {
          ...bound,
          restartRecoveryRequesterSource: replacement,
        });
        await expect(restore()).resolves.toBeUndefined();
      }
      for (const malformed of [
        { ...source.requesterOrigin, sessionKey: "" },
        { ...source.requesterOrigin, senderId: 7 },
        { ...source.requesterOrigin, senderId: undefined },
        { ...source.requesterOrigin, messageThreadId: {} },
      ]) {
        const invalid = structuredClone(source);
        Reflect.set(invalid, "requesterOrigin", malformed);
        await replaceSessionEntry(fixture.target, {
          ...bound,
          restartRecoveryRequesterSource: invalid,
        });
        await expect(restore()).resolves.toBeUndefined();
      }
      await replaceSessionEntry(fixture.target, {
        ...bound,
        restartRecoveryDeliveryRunId: "replacement-run",
      });
      await expect(restore()).rejects.toThrow("no longer owns this input");
      await replaceSessionEntry(fixture.target, bound);
      const pending = restore();
      current = false;
      await expect(pending).rejects.toThrow("recovery claim retired");
    });
  });

  it("restores requester custody and current operator policy across accepted compaction", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("model@example.test");
      setUserProfileRole(profile.id, "operator");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture/a" } },
        gateway: {
          roles: {
            definitions: {
              operator: {
                sessions: { others: "none" },
                agents: ["main"],
                scopes: ["operator.admin"],
                sandbox: "required",
                accessPolicyPlugin: undefined,
                modelPolicy: { allow: ["fixture/a", "fixture/b"] },
              },
            },
          },
        },
      };
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: cfg,
      });
      const requesterOrigin = {
        sessionKey: fixture.target.sessionKey,
        messageProvider: "webchat",
        senderId: profile.id,
        operatorProfileId: profile.id,
      };
      await replaceSessionEntry(fixture.target, {
        ...fixture.entry,
        restartRecoveryRequesterSource: expectDefined(
          createRestartRecoveryRequesterSource({
            ...fixture.target,
            entry: fixture.entry,
            requesterOrigin,
          }),
          "original authenticated requester",
        ),
      });
      const current = structuredClone(cfg);
      expectDefined(current.gateway?.roles?.definitions.operator, "operator role").modelPolicy = {
        allow: ["fixture/b", "fixture/c"],
      };
      let target = { ...fixture.target };
      const restore = (sourceTarget = target) =>
        restoreGatewayRunRecovery({
          target: sourceTarget,
          context: fixture.context,
          restoreOperator: true,
          restoreRequester: true,
          assertCurrent: () => {},
        });
      expect(fixture.sourceAuthority.assertCurrent).toThrow();
      // This reuses authenticated source owners without a Gateway restart or model boot.
      let recovered = await restore();
      const active = expectDefined(recovered.operator, "initial recovered operator");
      const restoredAuthorities = [active];
      try {
        expect(recovered.requesterOrigin).toEqual(requesterOrigin);
        for (const sessionId of ["first-successor", "second-successor"]) {
          const predecessor = expectDefined(
            await readSessionEntryReadOnlyInWorker(target),
            "current predecessor",
          );
          const predecessorTarget = target;
          const accepted = await acceptCompactionSuccessor({
            currentTarget: target,
            expectedEntry: {
              sessionId: predecessor.sessionId,
              lifecycleRevision: predecessor.lifecycleRevision,
              activeWriterRunId: predecessor.activeWriterRunId,
            },
            assertActive: active.authority.assertCurrent,
            onCommitted: () => {
              if (sessionId === "second-successor") {
                throw new Error("compaction fact observer failed");
              }
            },
            result: {
              ok: true,
              compacted: true,
              result: { sessionId, tokensBefore: 120, tokensAfter: 42 },
            },
          });
          expect(accepted.entry.sessionId).toBe(sessionId);
          fixture.setConfig(current);
          target = { ...fixture.target, sessionId };
          await expect(restore(predecessorTarget)).rejects.toThrow("no longer owns this input");
          recovered = await restore();
          const successor = expectDefined(recovered.operator, "restored successor authority");
          restoredAuthorities.push(successor);
          expect(recovered.requesterOrigin).toEqual(requesterOrigin);
          expect(active.authority.assertCurrent).not.toThrow();
          expect(active.authority.modelPolicy?.models).toEqual([
            { provider: "fixture", model: "b" },
          ]);
          expect(successor.authority.modelPolicy?.models).toEqual([
            { provider: "fixture", model: "b" },
          ]);
          expect(successor.authority.profileId).toBe(profile.id);
          expect(successor.authority.assertCurrent).not.toThrow();
        }
        const restored = expectDefined(recovered.operator, "model-restricted recovery");
        await expect(
          acceptCompactionSuccessor({
            currentTarget: fixture.target,
            expectedEntry: {
              sessionId: fixture.entry.sessionId,
              lifecycleRevision: fixture.entry.lifecycleRevision,
              activeWriterRunId: fixture.entry.activeWriterRunId,
            },
            assertActive: active.authority.assertCurrent,
            result: {
              ok: true,
              compacted: true,
              result: { sessionId: "stale-successor", tokensBefore: 120, tokensAfter: 42 },
            },
          }),
        ).rejects.toThrow(SessionTranscriptWriterClaimReboundError);
        expect(active.authority.assertCurrent).not.toThrow();
        expect(restored.authority.assertCurrent).not.toThrow();
        expect(restored.authority.rolePolicy).toMatchObject({
          agents: ["main"],
          sandboxRequired: true,
          sessionAccessCap: "none",
        });
        const widened = structuredClone(current);
        expectDefined(widened.gateway?.roles?.definitions.operator, "operator role").modelPolicy = {
          allow: ["fixture/a", "fixture/b", "fixture/c"],
        };
        fixture.setConfig(widened);
        expect(restored.authority.modelPolicy?.models).toEqual([
          { provider: "fixture", model: "b" },
        ]);
        setUserProfileRole(profile.id, "revoked");
        expect(active.authority.assertCurrent).toThrow("authority changed");
        expect(restored.authority.assertCurrent).toThrow("authority changed");
        await expect(restore()).rejects.toThrow(/Restart recovery operator/);
        const retainedSuccessor = expectDefined(
          await readSessionEntryReadOnlyInWorker(target),
          "retained successor",
        );
        await expect(
          acceptCompactionSuccessor({
            currentTarget: target,
            expectedEntry: {
              sessionId: retainedSuccessor.sessionId,
              lifecycleRevision: retainedSuccessor.lifecycleRevision,
              activeWriterRunId: retainedSuccessor.activeWriterRunId,
            },
            assertActive: active.authority.assertCurrent,
            result: {
              ok: true,
              compacted: true,
              result: { sessionId: "revoked-successor", tokensBefore: 120, tokensAfter: 42 },
            },
          }),
        ).rejects.toThrow("authority changed");
        expect((await readSessionEntryReadOnlyInWorker(target))?.sessionId).toBe(
          "second-successor",
        );
      } finally {
        for (const restored of restoredAuthorities.toReversed()) {
          restored.release();
        }
      }
    });
  });
});
