import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import * as spawnRuntime from "../agents/subagents/spawn/subagent-spawn.runtime.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveCronOperatorExecutionRevision } from "../cron/service/jobs-tool-policy.js";
import { loadCronJobsStore } from "../cron/store.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import * as cronNotifications from "./server-cron-notifications.js";

it("readmits pending native child and scheduled work under current invitation bounds", async ({
  signal,
}) => {
  const repair = cronNotifications.createGatewayCronFailureRepair;
  const repairFinished = createDeferred();
  using repairObserver = vi
    .spyOn(cronNotifications, "createGatewayCronFailureRepair")
    .mockImplementation((...args) => {
      const owner = repair(...args);
      return {
        ...owner,
        runCronFailureRepair: async (request) => {
          try {
            await owner.runCronFailureRepair(request);
          } finally {
            repairFinished.resolve();
          }
        },
      };
    });
  void repairObserver;
  await withInvitedGuestGateway(
    signal,
    async (fixture) => {
      const { sender, invited, carol, state, providerReplies, providerRequests, events } = fixture;
      const root = path.dirname(await state.writeText("bounded-root/read-proof.txt", "READ_PROOF"));
      const outside = state.path("outside-proof.txt");
      const inside = path.join(root, "write-proof.txt");
      const parent = await sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: "Native admission proof",
          visibility: "shared",
          cwd: root,
          permissionMode: "full",
        },
        { signal },
      );
      const target = { agentId: "main", sessionKey: parent.key };
      await sender.request(
        "session.members.add",
        { ...target, identityId: carol.id, access: "send" },
        { signal },
      );
      let sequence = 0;
      const reply = (response: Parameters<typeof writeToolCall>[0], text = "DONE") => {
        const id = `native-admission-${++sequence}`;
        writeOpenAiResponsesText(response, { text, messageId: id, responseId: id });
      };
      const wait = async (runId: string) => {
        expect(await sender.request("agent.wait", { runId }, { signal })).toMatchObject({
          status: "ok",
        });
      };
      let step = 0;
      providerReplies.reply = (_body, response) => {
        if (step++ === 0) {
          writeToolCall(response, "write", { path: inside, content: "BOUNDED_SUCCESS" });
        } else {
          reply(response);
        }
      };
      await invited.request(
        "chat.send",
        { ...target, message: "Positive bounded write", idempotencyKey: "bounded-success" },
        { signal },
      );
      await wait("bounded-success");
      expect(await fs.readFile(inside, "utf8")).toBe("BOUNDED_SUCCESS");
      const successfulWriteRequests = providerRequests.length;
      step = 0;
      providerReplies.reply = (_body, response) => {
        if (step++ === 0) {
          writeToolCall(response, "automations", {
            action: "plan",
            names: ["Native pending invitation"],
          });
        } else if (step === 2) {
          writeToolCall(response, "automations", {
            action: "add",
            job: {
              name: "Native pending invitation",
              deleteAfterRun: false,
              schedule: { kind: "at", at: new Date(Date.now() + 86_400_000).toISOString() },
              sessionTarget: `session:${parent.key}`,
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "NATIVE_OCCURRENCE" },
              delivery: { mode: "none" },
            },
          });
        } else {
          reply(response);
        }
      };
      await invited.request(
        "chat.send",
        { ...target, message: "Create the pending automation", idempotencyKey: "native-schedule" },
        { signal },
      );
      await wait("native-schedule");
      const [job] = (await loadCronJobsStore()).jobs;
      expect(job?.operatorSource?.source.snapshot.participationCeiling).toMatchObject({
        profileId: carol.id,
        sessionKey: parent.key,
        permission: "workspace",
        source: { root },
      });
      if (!job) {
        throw new Error("Model did not create its pending job");
      }
      const childEntered = createDeferred<{ sessionKey: string; runId: string }>();
      const releaseChild = createDeferred();
      const childFinished = createDeferred<unknown>();
      const dispatch = spawnRuntime.dispatchGatewayMethodInProcess;
      using heldChild = vi
        .spyOn(spawnRuntime, "dispatchGatewayMethodInProcess")
        .mockImplementation(async (...args) => {
          if (args[0] === "agent") {
            const params = args[1] as { sessionKey: string; idempotencyKey: string };
            childEntered.resolve({ sessionKey: params.sessionKey, runId: params.idempotencyKey });
            await withinTest(releaseChild.promise, signal);
            try {
              const result = await dispatch(...args);
              childFinished.resolve(result);
              return result;
            } catch (error) {
              childFinished.resolve({ error: String(error) });
              throw error;
            }
          }
          return dispatch(...args);
        });
      void heldChild;
      let childCalls = 0;
      providerReplies.reply = (body, response) => {
        if (body.includes("CHILD_MUST_NOT_EXECUTE") && !body.includes("CREATE_HELD_CHILD")) {
          childCalls++;
          writeToolCall(response, "write", { path: outside, content: "UNAUTHORIZED_CHILD" });
        } else if (
          !body.includes("function_call_output") ||
          !body.includes("CHILD_MUST_NOT_EXECUTE")
        ) {
          writeToolCall(response, "sessions_spawn", {
            task: "CHILD_MUST_NOT_EXECUTE",
            runtime: "subagent",
            context: "isolated",
            cleanup: "keep",
          });
        } else {
          reply(response);
        }
      };
      await invited.request(
        "chat.send",
        { ...target, message: "CREATE_HELD_CHILD", idempotencyKey: "native-held-parent" },
        { signal },
      );
      const child = await withinTest(childEntered.promise, signal);
      try {
        expect(
          (
            await readSessionEntryReadOnlyInWorker({
              agentId: "main",
              sessionKey: child.sessionKey,
            })
          )?.delegatedOperatorSource,
        ).toMatchObject({
          kind: "gateway",
          snapshot: {
            profileId: carol.id,
            participationCeiling: { sessionKey: parent.key, source: { root } },
          },
        });
        expect(childCalls).toBe(0);
        await sender.request(
          "session.members.remove",
          { ...target, identityId: carol.id },
          { signal },
        );
        const beforeRelease = providerRequests.length;
        releaseChild.resolve();
        const childReceipt = await withinTest(childFinished.promise, signal);
        expect(childReceipt).toMatchObject({ error: "Error: Session participation was revoked." });
        const parentReceipt = await sender.request(
          "agent.wait",
          { runId: "native-held-parent" },
          { signal },
        );
        console.info(
          "native-revocation-receipts",
          JSON.stringify({ child, childReceipt, parentReceipt }),
        );
        expect(parentReceipt).toMatchObject({ status: "error" });
        expect(childCalls).toBe(0);
        const afterParent = providerRequests.length;
        await sender.request(
          "cron.update",
          {
            id: job.id,
            patch: { schedule: { kind: "at", at: new Date(Date.now() + 1_000).toISOString() } },
          },
          { signal },
        );
        let dueReceipt: unknown;
        await vi.waitFor(
          () => {
            const finished = events.sender.find(
              (event) =>
                event.event === "cron" &&
                (event.payload as { jobId?: string; action?: string })?.jobId === job.id &&
                (event.payload as { action?: string }).action === "finished",
            );
            expect(finished).toBeDefined();
            dueReceipt = finished!.payload;
          },
          { timeout: 10_000 },
        );
        expect(dueReceipt).toMatchObject({
          status: "error",
          error: expect.stringContaining("authority"),
        });
        await withinTest(repairFinished.promise, signal);
        expect(providerRequests.length).toBe(afterParent);
        await expect(fs.access(outside)).rejects.toThrow();
        await sender.request(
          "session.members.add",
          { ...target, identityId: carol.id, access: "send" },
          { signal },
        );
        const patchRole = async (
          invitedPermission: "read-only" | "full",
          invitedTools: string[],
        ) => {
          const before = await sender.request<{ hash: string }>("config.get", {}, { signal });
          const receipt = await sender.request(
            "config.patch",
            {
              baseHash: before.hash,
              replacePaths: ["gateway.roles.definitions.invited.sessions.invitedTools"],
              raw: JSON.stringify({
                gateway: {
                  roles: {
                    definitions: { invited: { sessions: { invitedPermission, invitedTools } } },
                  },
                },
              }),
            },
            { signal },
          );
          expect(receipt).toMatchObject({
            sentinel: { payload: { stats: { requiresRestart: false } } },
          });
        };
        const outputs: string[] = [];
        let toolCalls = 0;
        const invokeStoredJob = async (phase: "permission" | "tools" | "wide") => {
          step = 0;
          providerReplies.reply = (body, response) => {
            const input = (JSON.parse(body) as { input: { type?: string; output?: string }[] })
              .input;
            const output = input.findLast((item) => item.type === "function_call_output")?.output;
            if (output) {
              outputs.push(output);
            }
            toolCalls++;
            if (step++ === 0) {
              writeToolCall(response, "write", {
                path: phase === "wide" ? outside : inside,
                content: `${phase.toUpperCase()}_FORBIDDEN`,
              });
            } else if (step === 2) {
              writeToolCall(response, "read", { path: path.join(root, "read-proof.txt") });
            } else if (step === 3 && phase === "wide") {
              writeToolCall(response, "exec", {
                command: "printf UNAUTHORIZED_EXEC",
                awaitResults: true,
              });
            } else {
              reply(response);
            }
          };
          const receipt = await sender.request(
            "cron.run",
            { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
            { signal },
          );
          expect(receipt).toMatchObject({ run: { status: "ok" } });
          return receipt;
        };
        await patchRole("read-only", ["automations", "read", "write", "sessions_spawn"]);
        const permission = await invokeStoredJob("permission");
        expect(await fs.readFile(inside, "utf8")).toBe("BOUNDED_SUCCESS");
        await patchRole("full", ["read"]);
        const narrow = await invokeStoredJob("tools");
        expect(await fs.readFile(inside, "utf8")).toBe("BOUNDED_SUCCESS");
        expect(outputs.join("\n")).toContain("READ_PROOF");
        expect(outputs.join("\n")).toMatch(/not found|not available|not allowed|denied/i);
        await patchRole("full", ["automations", "read", "write", "sessions_spawn", "exec"]);
        const wide = await invokeStoredJob("wide");
        await expect(fs.access(outside)).rejects.toThrow();
        expect(outputs.join("\n")).toMatch(/outside|escapes|workspace|root/i);
        expect(outputs.at(-1)).toBe("Tool exec not found");
        expect(outputs.join("\n")).not.toContain("UNAUTHORIZED_EXEC");
        const retainedJob = (await loadCronJobsStore()).jobs.find((item) => item.id === job.id)!;
        expect(retainedJob.operatorSource?.source).toEqual(job.operatorSource?.source);
        // The owner changed the schedule, so its definition seal changes, not its creator source.
        expect(retainedJob.operatorSource?.executionRevision).toBe(
          resolveCronOperatorExecutionRevision(retainedJob),
        );
        expect(retainedJob.operatorSource?.executionRevision).not.toBe(
          job.operatorSource?.executionRevision,
        );
        expect(toolCalls).toBe(10);
        expect(afterParent).toBe(beforeRelease);
        // No membership is ever created on this independent owner-only session.
        const owner = await sender.request<{ key: string }>(
          "sessions.create",
          { agentId: "main", label: "Owner only", permissionMode: "full" },
          { signal },
        );
        step = 0;
        providerReplies.reply = (_body, response) => {
          if (step++ === 0) {
            writeToolCall(response, "write", { path: outside, content: "OWNER_SUCCESS" });
          } else {
            reply(response);
          }
        };
        await sender.request(
          "chat.send",
          {
            agentId: "main",
            sessionKey: owner.key,
            message: "Owner ordinary write",
            idempotencyKey: "owner-only-success",
          },
          { signal },
        );
        await wait("owner-only-success");
        expect(await fs.readFile(outside, "utf8")).toBe("OWNER_SUCCESS");
        await sender.request("cron.remove", { id: job.id }, { signal });
        console.info(
          "native-admission-proof",
          JSON.stringify({
            parent,
            jobId: job.id,
            child,
            childReceipt,
            dueReceipt,
            successfulWriteRequests,
            beforeRelease,
            afterParent,
            childCalls,
            toolCalls,
            permission,
            narrow,
            wide,
            outputs,
            ownerKey: owner.key,
            finalProviderRequests: providerRequests.length,
          }),
        );
      } finally {
        releaseChild.resolve();
      }
    },
    {
      maxInvitedAccess: "send",
      invitedScopes: ["operator.sessions.read", "operator.cron"],
      invitedTools: ["automations", "read", "write", "sessions_spawn"],
      cronEnabled: true,
      tools: {
        allow: ["automations", "read", "write", "sessions_spawn", "exec"],
        codeMode: { enabled: false },
        toolSearch: false,
      },
    },
  );
});
