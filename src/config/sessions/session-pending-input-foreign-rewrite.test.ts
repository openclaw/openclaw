import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/shared-types.js";
import { resolveSessionMutationAuthorizationAsync } from "../../gateway/session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../../gateway/session-sharing.test-utils.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "./session-accessor.pending-inputs.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";

it.each([false, true])(
  "retains foreign input authority through transcript rewrite (revoked: %s)",
  async (revoked) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = rolePolicyConfig();
      const client = roleClient("view", "foreign-mirror-member");
      const profileId = expectDefined(client.authenticatedUserProfile, "fixture profile").profileId;
      const source = {
        agentId: "main",
        sessionKey: "agent:main:foreign-mirror-source",
        sessionId: "foreign-mirror-source",
      };
      await upsertSessionEntryCore(source, {
        sessionId: source.sessionId,
        updatedAt: 1,
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      await addSessionMember(source, { identityId: profileId, addedBy: "another-profile" });
      const resolved = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: source,
        // SAFETY: This authorization fixture only consumes the live runtime config getter.
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
      expect(resolved.error).toBeNull();
      const authorization = expectDefined(resolved.authorization, "source authorization");
      const receipt = expectDefined(
        await stageSessionPendingInput(source, {
          runId: "foreign-mirror",
          message: {
            role: "user",
            content: "Accepted source input",
            timestamp: 2,
            idempotencyKey: "foreign-mirror:user",
          },
          assertCurrent: authorization.assertCurrent,
          assertAdmittedCurrent: authorization.assertCurrent,
          authority: expectDefined(authorization.admittedInputAuthority, "source input authority"),
        }),
        "pending input receipt",
      );
      try {
        const target = {
          agentId: "other",
          sessionKey: "agent:other:foreign-mirror-target",
          sessionId: "foreign-mirror-target",
          storePath: path.join(state.agentDir("other"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const earlier: PersistedUserTurnMessage = {
          role: "user",
          content: "Earlier destination input",
          timestamp: 1,
        };
        const earlierId = expectDefined(
          await manager.appendMessageAsync(earlier),
          "destination entry",
        );
        const pending = await listSessionPendingInputs(source);
        const sourceTranscript = await loadTranscriptEvents(source);
        const destinationTranscript = await loadTranscriptEvents(target);
        const run = expectDefined(receipt.runAsync, "asynchronous custody");
        const result = run(async () => {
          const rewrite = await manager.prepareTranscriptRewriteAsync();
          await rewrite.sessionManager.resetLeafAsync();
          const replacementId = expectDefined(
            await rewrite.sessionManager.appendMessageAsync(receipt.message),
            "prepared replacement",
          );
          if (revoked) {
            await removeSessionMember(source, profileId);
          }
          await rewrite.commit(new Map([[earlierId, replacementId]]));
        });
        if (revoked) {
          await expect(result).rejects.toThrow("session is read-only");
          expect(await loadTranscriptEvents(target)).toEqual(destinationTranscript);
        } else {
          await expect(result).resolves.toBeUndefined();
          expect(manager.getBranch().filter((entry) => entry.type === "message")).toMatchObject([
            { message: { role: "user", content: receipt.message.content } },
          ]);
          expect(manager.getLeafId()).not.toBe(receipt.inputId);
        }
        expect(await listSessionPendingInputs(source)).toEqual(pending);
        expect(await loadTranscriptEvents(source)).toEqual(sourceTranscript);
      } finally {
        receipt.finish("interrupted");
        await receipt.settled?.();
      }
    });
  },
);
