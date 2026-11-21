import type { ServerResponse } from "node:http";
import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import {
  findSubagentSpawnReceipt,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";

const parentPrompt = "Start the participant's native child proof.";
const childTask = "Start the participant's native grandchild proof.";
const grandchildTask = "Return the participant's isolated grandchild result.";
const childResult = "PRIVATE_PARTICIPANT_CHILD_RESULT_61c1";
const grandchildResult = "PRIVATE_PARTICIPANT_GRANDCHILD_RESULT_8b4e";
const ownerPrompt = "Run the creator's independent subsequent turn.";
const resetPrompt = "Continue the reset participant child with its original ceiling.";
const participantTools = ["read", "sessions_spawn"];

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it("carries a real invitee's native child and grandchild ceiling through private completion and revocation", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ sender, invited, carol, alice, state, providerReplies, providerRequests, events }) => {
      const sourceRoot = dirname(
        await state.writeText("participant-source/root-proof.txt", "source root"),
      );
      expect(sourceRoot).not.toBe(state.workspaceDir);
      const parent = await sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: "Native participation source",
          visibility: "shared",
          permissionMode: "full",
          cwd: sourceRoot,
        },
        { signal },
      );
      await sender.request(
        "session.members.add",
        { agentId: "main", sessionKey: parent.key, identityId: carol.id, access: "send" },
        { signal },
      );
      const source = await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        sessionKey: parent.key,
      });
      expect(source?.createdActor).toEqual({ type: "human", source: "profile", id: alice.id });
      expect(source?.sessionRoot).toBe(sourceRoot);
      const childAccepted = createDeferred<SpawnReceipt>();
      const grandchildAccepted = createDeferred<SpawnReceipt>();
      const grandchildStarted = createDeferred<ServerResponse>();
      const parentCompletion = createDeferred();
      const childCompletion = createDeferred();
      const requests: { phase: string; tools: string[] }[] = [];
      let sequence = 0;
      const reply = (response: ServerResponse, text: string) => {
        const id = `participation-native-${++sequence}`;
        writeOpenAiResponsesText(response, { text, messageId: id, responseId: `${id}-response` });
      };
      const spawn = (response: ServerResponse, task: string) =>
        writeToolCall(response, "sessions_spawn", {
          task,
          context: "isolated",
          runtime: "subagent",
          completionTarget: "parent",
          cleanup: "keep",
        });
      providerReplies.reply = (body, response) => {
        const request = JSON.parse(body) as { tools: { name: string }[]; input: unknown[] };
        const record = (phase: string) =>
          requests.push({ phase, tools: request.tools.map(({ name }) => name).toSorted() });
        if (body.includes(ownerPrompt)) {
          record("owner");
          reply(response, "Creator turn complete.");
        } else if (body.includes(parentPrompt)) {
          if (body.includes(childResult)) {
            record("parent-completion");
            parentCompletion.resolve();
            reply(response, "NO_REPLY");
          } else if (!body.includes("function_call_output")) {
            record("invitee");
            spawn(response, childTask);
          } else {
            record("invitee-receipt");
            const receipt = findSubagentSpawnReceipt(request.input);
            if (receipt) {
              childAccepted.resolve(receipt);
            } else {
              childAccepted.reject(
                new Error(`Native child was not accepted: ${JSON.stringify(request.input.at(-1))}`),
              );
            }
            reply(response, "Child accepted.");
          }
        } else if (body.includes(resetPrompt)) {
          record("child-reset");
          reply(response, "Reset child complete.");
        } else if (body.includes(childTask)) {
          if (body.includes(grandchildResult)) {
            record("child-completion");
            childCompletion.resolve();
            reply(response, "NO_REPLY");
          } else if (!body.includes("function_call_output")) {
            record("child");
            spawn(response, grandchildTask);
          } else {
            record("child-receipt");
            const receipt = findSubagentSpawnReceipt(request.input);
            if (receipt) {
              grandchildAccepted.resolve(receipt);
            } else {
              grandchildAccepted.reject(
                new Error(
                  `Native grandchild was not accepted: ${JSON.stringify(request.input.at(-1))}`,
                ),
              );
            }
            reply(response, childResult);
          }
        } else if (body.includes(grandchildTask)) {
          record("grandchild");
          // The provider is the only substituted boundary. Keep the descendant alive
          // until both public spawn receipts and the idle parent are observed.
          grandchildStarted.resolve(response);
        } else {
          record("unexpected");
          reply(response, "NO_REPLY");
        }
      };
      // Attach rejection handlers before the model can report an unsuccessful spawn.
      const receipts = Promise.all([childAccepted.promise, grandchildAccepted.promise]);
      void receipts.catch(() => undefined);
      const initialRunId = "participation-native-parent";
      await invited.request(
        "chat.send",
        {
          agentId: "main",
          sessionKey: parent.key,
          message: parentPrompt,
          idempotencyKey: initialRunId,
        },
        { signal },
      );
      const [child, grandchild] = await withinTest(receipts, signal);
      const heldResponse = await withinTest(grandchildStarted.promise, signal);
      const wait = (runId: string) =>
        expect(sender.request("agent.wait", { runId }, { signal })).resolves.toMatchObject({
          status: "ok",
        });
      try {
        await wait(initialRunId);
        const expectedCeiling = {
          kind: "send",
          profileId: carol.id,
          sessionKey: parent.key,
          permission: "workspace",
          execPolicy: { security: "allowlist", ask: "on-miss" },
          tools: participantTools,
          source: {
            agentId: "main",
            sessionId: parent.sessionId,
            lifecycleRevision: source?.lifecycleRevision ?? null,
            creatorProfileId: alice.id,
            root: sourceRoot,
          },
        };
        for (const [receipt, parentKey, depth] of [
          [child, parent.key, 1],
          [grandchild, child.childSessionKey, 2],
        ] as const) {
          expect(receipt.childSessionKey).toMatch(/^agent:main:subagent:/);
          const entry = await readSessionEntryReadOnlyInWorker({
            agentId: "main",
            sessionKey: receipt.childSessionKey,
          });
          expect(entry).toMatchObject({
            parentSessionKey: parentKey,
            spawnedBy: parentKey,
            spawnDepth: depth,
            sessionRoot: expectedCeiling.source.root,
            inheritedToolPolicySource: "participant",
            participationCeiling: expectedCeiling,
          });
          expect(entry?.subagentRole).toBe("orchestrator");
          expect(entry?.sidebarRoot).not.toBe(true);
        }
        const delivered = createDeferred();
        const observe = () => {
          const runs = [
            ...listSubagentRunsForRequester(parent.key),
            ...listSubagentRunsForRequester(child.childSessionKey),
          ];
          if (
            [child, grandchild].every((receipt) =>
              runs.some(
                (run) => run.runId === receipt.runId && run.delivery?.status === "delivered",
              ),
            )
          ) {
            delivered.resolve();
          }
        };
        const unsubscribe = subscribeSubagentRunChanges("persistence", observe);
        try {
          reply(heldResponse, grandchildResult);
          observe();
          await withinTest(
            Promise.all([parentCompletion.promise, childCompletion.promise, delivered.promise]),
            signal,
          );
          await wait(grandchild.runId);
        } finally {
          unsubscribe();
        }
        for (const phase of [
          "invitee",
          "child",
          "grandchild",
          "parent-completion",
          "child-completion",
        ]) {
          expect(requests.filter((request) => request.phase === phase)).not.toHaveLength(0);
        }
        expect(requests.some((request) => request.phase === "unexpected")).toBe(false);
        for (const request of requests) {
          expect(request.tools, request.phase).toEqual(participantTools);
        }
        for (const [sessionKey, receipt, privateResult] of [
          [parent.key, child, childResult],
          [child.childSessionKey, grandchild, grandchildResult],
        ] as const) {
          const history = await sender.request<{ messages: { subagentCompletions?: unknown[] }[] }>(
            "chat.history",
            { agentId: "main", sessionKey },
            { signal },
          );
          expect(
            history.messages.flatMap((message) => message.subagentCompletions ?? []),
          ).toContainEqual(
            expect.objectContaining({ runId: receipt.runId, sessionKey: receipt.childSessionKey }),
          );
          expect(JSON.stringify(history.messages)).not.toContain(privateResult);
        }
        // A same-socket RPC fences prior event delivery before the negative disclosure check.
        await invited.request(
          "chat.history",
          { agentId: "main", sessionKey: parent.key },
          { signal },
        );
        const parentEvents = events.invited.filter((event) => {
          const payload = event.payload as { sessionKey?: string } | undefined;
          return payload?.sessionKey === parent.key;
        });
        expect(JSON.stringify(parentEvents)).not.toContain(childResult);
        expect(JSON.stringify(parentEvents)).not.toContain(grandchildResult);
        expect(JSON.stringify(events.guest)).not.toContain(childResult);
        await sender.request(
          "sessions.reset",
          { agentId: "main", key: child.childSessionKey },
          { signal },
        );
        const resetDelivered = createDeferred();
        const observeReset = () => {
          if (
            listSubagentRunsForRequester(parent.key).some(
              (run) => run.runId === "native-child-reset" && run.delivery?.status === "delivered",
            )
          ) {
            resetDelivered.resolve();
          }
        };
        const stopReset = subscribeSubagentRunChanges("persistence", observeReset);
        try {
          await sender.request(
            "chat.send",
            {
              agentId: "main",
              sessionKey: child.childSessionKey,
              message: resetPrompt,
              idempotencyKey: "native-child-reset",
            },
            { signal },
          );
          await wait("native-child-reset");
          observeReset();
          await withinTest(resetDelivered.promise, signal);
        } finally {
          stopReset();
        }
        expect(
          requests.findLast((request) => request.phase === "parent-completion")?.tools,
        ).toEqual(participantTools);
        expect(requests.filter((request) => request.phase === "child-reset")).toEqual([
          { phase: "child-reset", tools: participantTools },
        ]);
        await sender.request(
          "session.members.setAccess",
          { agentId: "main", sessionKey: parent.key, identityId: carol.id, access: "read" },
          { signal },
        );
        const beforeRevocation = providerRequests.length;
        for (const descendant of [child, grandchild]) {
          for (const method of ["chat.send", "agent"] as const) {
            await expect(
              sender.request(
                method,
                {
                  agentId: "main",
                  sessionKey: descendant.childSessionKey,
                  message: "The revoked participant must not continue through admin ingress.",
                  idempotencyKey: `revoked-${method}-${descendant.runId}`,
                },
                { signal },
              ),
            ).rejects.toThrow();
          }
        }
        expect(providerRequests).toHaveLength(beforeRevocation);
        const childScope = { agentId: "main", sessionKey: child.childSessionKey };
        expect(
          (
            await deleteSessionEntryLifecycle({
              ...childScope,
              storePath: resolveSessionStorePathForScope(childScope),
              target: { canonicalKey: child.childSessionKey, storeKeys: [child.childSessionKey] },
              archiveTranscript: false,
            })
          ).deleted,
        ).toBe(true);
        expect(listSubagentRunsForRequester(parent.key)).toContainEqual(
          expect.objectContaining({ runId: child.runId, participationCeiling: expectedCeiling }),
        );
        for (const method of ["chat.send", "agent"] as const) {
          await expect(
            sender.request(
              method,
              {
                ...childScope,
                message: "A deleted participant child must not become owner work.",
                idempotencyKey: `missing-${method}-${child.runId}`,
              },
              { signal },
            ),
          ).rejects.toThrow();
          expect(await readSessionEntryReadOnlyInWorker(childScope)).toBeUndefined();
        }
        expect(providerRequests).toHaveLength(beforeRevocation);
        await sender.request(
          "chat.send",
          {
            agentId: "main",
            sessionKey: parent.key,
            message: ownerPrompt,
            idempotencyKey: "native-owner",
          },
          { signal },
        );
        await wait("native-owner");
        expect(requests.filter((request) => request.phase === "owner")).toEqual([
          { phase: "owner", tools: ["exec", "read", "sessions_spawn"] },
        ]);
        const parentAfter = await readSessionEntryReadOnlyInWorker({
          agentId: "main",
          sessionKey: parent.key,
        });
        expect(parentAfter?.participationCeiling).toBeUndefined();
        expect(parentAfter?.inheritedToolPolicySource).not.toBe("participant");
      } finally {
        if (!heldResponse.writableEnded) {
          reply(heldResponse, "NO_REPLY");
        }
      }
    },
    {
      maxInvitedAccess: "send",
      invitedScopes: ["operator.sessions.read"],
      invitedTools: participantTools,
      tools: {
        allow: ["read", "exec", "sessions_spawn"],
        toolSearch: false,
        codeMode: { enabled: false },
      },
    },
  );
});
