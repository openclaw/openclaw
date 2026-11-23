import type { ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import {
  findSubagentSpawnReceipt,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it("keeps default-mode participant authority when publishing after a native child completion wake", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ sender, invited, carol, providerReplies }) => {
      const parent = await sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: "Default participant completion",
          visibility: "shared",
        },
        { signal },
      );
      const target = { agentId: "main", sessionKey: parent.key };
      await sender.request(
        "session.members.add",
        { ...target, identityId: carol.id, access: "send" },
        { signal },
      );
      expect((await readSessionEntryReadOnlyInWorker(target))?.permissionMode).toBeUndefined();
      const parentPrompt = "Start native review then publish its result.";
      const childTask = "Return the isolated native review.";
      const childResult = "NATIVE_REVIEW_COMPLETE_45b9";
      const childAccepted = createDeferred<SpawnReceipt>();
      const childStarted = createDeferred<ServerResponse>();
      const publication = createDeferred<string>();
      let publishing = false;
      let sequence = 0;
      const reply = (response: ServerResponse, text: string) => {
        const id = `participant-wake-${++sequence}`;
        writeOpenAiResponsesText(response, { text, messageId: id, responseId: `${id}-response` });
      };
      providerReplies.reply = (body, response) => {
        const request = JSON.parse(body) as { input: unknown[] };
        if (body.includes(parentPrompt)) {
          if (publishing) {
            publication.resolve(JSON.stringify(request.input));
            reply(response, "Publication result observed.");
          } else if (body.includes(childResult)) {
            publishing = true;
            writeToolCall(response, "github_publish", { draft: true });
          } else if (!body.includes("function_call_output")) {
            writeToolCall(response, "sessions_spawn", {
              task: childTask,
              context: "isolated",
              runtime: "subagent",
              completionTarget: "parent",
              cleanup: "keep",
            });
          } else {
            const receipt = findSubagentSpawnReceipt(request.input);
            if (receipt) {
              childAccepted.resolve(receipt);
            } else {
              childAccepted.reject(
                new Error(`Spawn failed: ${JSON.stringify(request.input.at(-1))}`),
              );
            }
            writeToolCall(response, "sessions_yield", {});
          }
        } else if (body.includes(childTask)) {
          childStarted.resolve(response);
        } else {
          reply(response, "NO_REPLY");
        }
      };
      void childAccepted.promise.catch(() => undefined);
      await invited.request(
        "chat.send",
        { ...target, message: parentPrompt, idempotencyKey: "default-participant-parent" },
        { signal },
      );
      const child = await withinTest(childAccepted.promise, signal);
      const held = await withinTest(childStarted.promise, signal);
      try {
        await expect(
          sender.request("agent.wait", { runId: "default-participant-parent" }, { signal }),
        ).resolves.toMatchObject({ status: "ok" });
        expect(listSubagentRunsForRequester(parent.key)).toContainEqual(
          expect.objectContaining({
            runId: child.runId,
            requesterOperatorSource: expect.objectContaining({
              kind: "gateway",
              snapshot: expect.objectContaining({
                participationCeiling: expect.objectContaining({
                  profileId: carol.id,
                  permission: "workspace",
                }),
              }),
            }),
            requesterSettleWake: expect.objectContaining({ requesterYieldBatch: true }),
          }),
        );
        reply(held, childResult);
        const result = await withinTest(publication.promise, signal);
        expect(result).not.toContain("changed between default and explicit permissions");
        // The synthetic Gateway has no configured publisher: reach that boundary, not an authority mismatch.
        expect(result).toContain("GitHub publication result:");
        expect((await readSessionEntryReadOnlyInWorker(target))?.permissionMode).toBeUndefined();
      } finally {
        if (!held.writableEnded && !held.destroyed) {
          reply(held, "NO_REPLY");
        }
      }
    },
    {
      maxInvitedAccess: "send",
      invitedScopes: ["operator.sessions.read"],
      invitedTools: ["sessions_spawn", "sessions_yield", "github_publish"],
      tools: {
        allow: ["sessions_spawn", "sessions_yield", "github_publish"],
        toolSearch: false,
        codeMode: { enabled: false },
      },
    },
  );
});
