import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { readPersistedFileStat } from "../agents/sessions/tools/file-write-verification.js";
import { createWriteTool } from "../agents/sessions/tools/write.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { isMissingPathError } from "../infra/errors.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { operatorSessionCap, resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import {
  isGatewayAdmin,
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
} from "./session-sharing-policy.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  const isolated = installPrivateUpdateHandoffStore(directories.make("sharing-publication-"));
  isolated.assertDatabasePath(resolveManagedUpdateLeaseDatabasePath());
});
afterEach(() => vi.restoreAllMocks());

const chain = (error: unknown): string[] =>
  error instanceof Error
    ? [error.message, ...(error.cause ? chain(error.cause) : [])]
    : [String(error)];

it.each([
  "benign",
  "member-before",
  "visibility-before",
  "member-after",
  "visibility-after",
] as const)(
  "first post-publication final effect consumes current access: %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const ctx = createContext();
      ctx.getSessionEventSubscriberConnIds = () => new Set();
      const profile = ensureProfileForEmail("member@example.test");
      const creator = ensureProfileForEmail("creator@example.test");
      // Creator stamps are immutable: seed the other creator before preparing the invited caller.
      await createOperatorRecoveryFixture({
        stateDir,
        context: ctx,
        profileId: creator.id,
        config: rolePolicyConfig(),
        scopes: ["operator.read", "operator.write"],
      });
      setUserProfileRole(profile.id, "view");
      const fixture = await createOperatorRecoveryFixture({
        stateDir,
        context: ctx,
        profileId: profile.id,
        config: rolePolicyConfig(),
        scopes: ["operator.read", "operator.write"],
      });
      prepareGatewayRecipientProfile(fixture.client);
      const entry = (await replaceSessionEntry(fixture.target, {
        ...fixture.entry,
        visibility: "read-only" as const,
      }))!;
      await addSessionMember(fixture.target, { identityId: profile.id, addedBy: creator.id });
      const restored = await fixture.restore();
      expect(restored).toBeDefined();
      const auth = await resolveSessionMutationAuthorizationAsync({
        client: fixture.client,
        context: ctx,
        method: "chat.send",
        requestParams: { sessionKey: fixture.target.sessionKey, agentId: "main" },
      });
      expect(auth.error).toBeNull();
      const source = auth.authorization!.retainForRun!();
      auth.authorization!.release?.();
      const sharingTarget = await resolveSessionSharingTargetAsync({
        cfg: ctx.getRuntimeConfig(),
        ...fixture.target,
      });
      expect(sharingTarget).not.toBeNull();
      const roleFacts = () => ({
        actor: resolveGatewayOperatorRoleActor(fixture.client) ?? null,
        cap: operatorSessionCap(fixture.client, ctx.getRuntimeConfig()) ?? null,
        admin: isGatewayAdmin(fixture.client),
        memberTrue: resolveSessionSharingRole({
          cfg: ctx.getRuntimeConfig(),
          client: fixture.client,
          target: sharingTarget!,
          isMember: true,
        }),
        memberFalse: resolveSessionSharingRole({
          cfg: ctx.getRuntimeConfig(),
          client: fixture.client,
          target: sharingTarget!,
          isMember: false,
        }),
      });
      expect(entry.createdActor?.id).toBe(creator.id);
      expect(entry.createdActor?.id).not.toBe(profile.id);
      expect(roleFacts()).toMatchObject({
        actor: { kind: "operator", profileId: profile.id },
        cap: "view",
        admin: false,
        memberTrue: "member",
        memberFalse: "viewer",
      });
      const runId = "sharing-publication-" + change;
      const admission = prepareSystemAgentRunAdmission(
        {},
        runId,
        "main",
        "session-sharing-publication",
        source.assertCurrent,
        restored!.authority,
      );
      let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
      let writes = 0;
      try {
        await withSessionTurn(fixture.target, async (_operation, abortSignal) => {
          const admitted = await admission.admit("plugin-harness", "sharing-harness");
          bindGatewayContextResolver(admitted, () => ctx);
          host = createAgentHarnessHostCapabilities({
            pluginId: "fixture",
            attempt: { runId, ...fixture.target, admittedRunContext: admitted, abortSignal },
          });
          const tool = host.capabilities.bindToolSurface([
            createWriteTool(stateDir, {
              operations: {
                mkdir: async (dir) => {
                  await mkdir(dir, { recursive: true });
                },
                readFile,
                statFile: (file) => readPersistedFileStat(file, isMissingPathError),
                writeFile: async (file, content) => {
                  writes++;
                  await writeFile(file, content, "utf8");
                },
              },
            }),
          ])[0]!;
          await tool.execute("first", { path: "access.txt", content: "first\n" });
          expect(writes).toBe(1);
          const publish = () =>
            emitSessionsChanged(ctx, { reason: "sharing-publication" }, { accessChanged: false });
          const revoke = async () => {
            if (change.startsWith("member")) {
              await removeSessionMember(fixture.target, profile.id);
            } else {
              await replaceSessionEntry(fixture.target, { ...entry, visibility: "draft" });
            }
          };
          if (change === "benign") {
            publish();
          } else if (change.endsWith("before")) {
            await revoke();
            publish();
          } else {
            publish();
            await revoke();
          }
          // No authority/admission assertion may run between revoke and the effect:
          // it would pre-latch refusal and invalidate this first-effect test.
          let refusal: unknown;
          try {
            await tool.execute("second", { path: "access.txt", content: "second\n" });
          } catch (error) {
            refusal = error;
          }
          let replayRefusal: unknown;
          const secondWrites = writes;
          const secondContents = await readFile(path.join(stateDir, "access.txt"), "utf8");
          if (change !== "benign") {
            try {
              await tool.execute("late-replay", { path: "access.txt", content: "replayed\n" });
            } catch (error) {
              replayRefusal = error;
            }
          }
          const contents = await readFile(path.join(stateDir, "access.txt"), "utf8");
          if (change !== "benign") {
            expect(() => source.assertCurrent()).toThrow(
              change.startsWith("member")
                ? "session is read-only for this connection"
                : "session is draft for this connection",
            );
            expect(secondWrites).toBe(1);
            expect(secondContents).toBe("first\n");
          }
          // Fresh authorization follows the physical effect, replay, and access-specific assertion.
          // Its independent verdict must not replace those retained-source and physical-write oracles.
          const fresh = await resolveSessionMutationAuthorizationAsync({
            client: fixture.client,
            context: ctx,
            method: "chat.send",
            requestParams: { sessionKey: fixture.target.sessionKey, agentId: "main" },
          });
          fresh.authorization?.release?.();
          if (change === "benign") {
            expect(fresh.error).toBeNull();
            expect(refusal).toBeUndefined();
            expect(writes).toBe(2);
            expect(contents).toBe("second\n");
            expect(() => source.assertCurrent()).not.toThrow();
          } else {
            expect(fresh.error?.message).toMatch(/session is (read-only|draft)/);
            expect(refusal).toBeDefined();
            expect(chain(refusal)).toEqual(["agent harness host capability is no longer active"]);
            expect(replayRefusal).toBeDefined();
            expect(chain(replayRefusal)).toEqual([
              "agent harness host capability is no longer active",
            ]);
            expect(writes).toBe(1);
            expect(contents).toBe("first\n");
          }
        });
      } finally {
        host?.close();
        admission.close();
        source.release?.();
        restored!.release();
      }
    });
  },
  45000,
);
