import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import type { ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SessionEventReceipt } from "../auto-reply/reply/session-event-contract.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import {
  findSubagentSpawnReceipt,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";
import * as restartResume from "./session-restart-resume.js";

const tools = ["exec", "read", "sessions_spawn", "sessions_yield"];
const rootPrompt = "NATIVE_DESCENDANT_ROOT_SPAWN";
const activePrompt = "NATIVE_DESCENDANT_ROOT_INTERRUPTED";
const childTask = "NATIVE_DESCENDANT_CHILD_TASK";
const proof = "NATIVE_DESCENDANT_EXEC_PROOF";
afterEach(() => resetSubagentRegistryForTests({ persist: false }));

for (const gate of ["approval", "restart"] as const) {
  it(`preserves the original participant through native descendant ${gate}`, async ({ signal }) => {
    let recovered = createDeferred();
    const resume = restartResume.resumeMarkedSessions;
    using recoveryObserver = vi
      .spyOn(restartResume, "resumeMarkedSessions")
      .mockImplementation(async (...args) => {
        try {
          await resume(...args);
        } finally {
          recovered.resolve();
        }
      });
    void recoveryObserver;
    const resumed = createDeferred<SessionEventReceipt>();
    const enqueue = sessionEvents.enqueueSessionEventForHost;
    using eventObserver = vi
      .spyOn(sessionEvents, "enqueueSessionEventForHost")
      .mockImplementation((...args) => {
        const receipt = enqueue(...args);
        if (args[1].source === "restart") {
          resumed.resolve(receipt);
        }
        return receipt;
      });
    void eventObserver;
    await withInvitedGuestGateway(
      signal,
      async (fixture) => {
        const { carol, alice, state, events, providerReplies, providerRequests } = fixture;
        await withinTest(recovered.promise, signal);
        const rpc = <T = unknown>(
          client: "sender" | "invited",
          method: string,
          params: unknown,
        ) => {
          return fixture[client].request<T>(method, params, { signal });
        };
        const parent = await rpc<{ key: string; sessionId: string }>("sender", "sessions.create", {
          agentId: "main",
          label: `Descendant ${gate}`,
          visibility: "shared",
          permissionMode: "full",
        });
        const target = { agentId: "main", sessionKey: parent.key };
        const send = (message: string, idempotencyKey: string) =>
          rpc("invited", "chat.send", { ...target, message, idempotencyKey });
        const wait = (runId: string) =>
          expect(rpc("sender", "agent.wait", { runId })).resolves.toMatchObject({ status: "ok" });
        await rpc("sender", "session.members.add", {
          ...target,
          identityId: carol.id,
          access: "send",
        });
        await rpc("invited", "sessions.messages.subscribe", {
          key: parent.key,
          includeApprovals: true,
        });
        const source = await readSessionEntryReadOnlyInWorker(target);
        const accepted = createDeferred<SpawnReceipt>();
        const childStarted = createDeferred();
        const rootStarted = createDeferred();
        const calls: { role: string; restarted: boolean; tools: string[] }[] = [];
        const outputs: unknown[] = [];
        let rootStep = 0;
        let childStep = 0;
        let restarting = false;
        const reply = (response: ServerResponse, text: string) =>
          writeOpenAiResponsesText(response, {
            text,
            messageId: `descendant-${calls.length}`,
            responseId: `descendant-response-${calls.length}`,
          });
        providerReplies.reply = (body, response) => {
          const request = JSON.parse(body) as {
            tools: { name: string }[];
            input: { type?: string; output?: unknown }[];
          };
          const root = body.includes(activePrompt) || body.includes(rootPrompt);
          const role = root ? "root" : body.includes(childTask) ? "child" : "unexpected";
          calls.push({
            role,
            restarted: restarting,
            tools: request.tools.map(({ name }) => name).toSorted(),
          });
          if (role === "root" && (restarting || body.includes(activePrompt))) {
            if (restarting) {
              reply(response, "ROOT_RESUMED_WITH_PARTICIPANT");
            } else {
              rootStarted.resolve();
            }
          } else if (role === "root") {
            if (rootStep++ === 0) {
              writeToolCall(response, "sessions_spawn", {
                task: childTask,
                context: "isolated",
                runtime: "subagent",
                completionTarget: "parent",
                cleanup: "keep",
              });
            } else if (rootStep === 2) {
              const receipt = findSubagentSpawnReceipt(request.input);
              if (receipt) {
                accepted.resolve(receipt);
              } else {
                accepted.reject(new Error(`Spawn refused: ${JSON.stringify(request.input)}`));
              }
              writeToolCall(response, "sessions_yield", {});
            } else {
              reply(response, "NO_REPLY");
            }
          } else if (role === "child") {
            childStarted.resolve();
            if (gate === "restart" && !restarting) {
              return;
            }
            if (childStep++ === 0) {
              writeToolCall(response, "exec", {
                command: `printf ${proof}`,
                host: "gateway",
                awaitResults: true,
              });
            } else {
              outputs.push(
                ...request.input
                  .filter((item) => item.type === "function_call_output")
                  .map((item) => item.output),
              );
              reply(response, "PRIVATE_DESCENDANT_COMPLETE");
            }
          } else {
            reply(response, "NO_REPLY");
          }
        };
        void accepted.promise.catch(() => undefined);
        const rootRunId = `native-descendant-${gate}`;
        await send(rootPrompt, rootRunId);
        const child = await withinTest(accepted.promise, signal);
        await withinTest(childStarted.promise, signal);
        await wait(rootRunId);
        const childRun = () =>
          listSubagentRunsForRequester(parent.key).find((run) => run.runId === child.runId);
        const childScope = { agentId: "main", sessionKey: child.childSessionKey };
        const entry = await readSessionEntryReadOnlyInWorker(childScope);
        expect(entry).toMatchObject({
          parentSessionKey: parent.key,
          delegatedOperatorSource: {
            kind: "gateway",
            snapshot: {
              profileId: carol.id,
              participationCeiling: {
                profileId: carol.id,
                sessionKey: parent.key,
                permission: "workspace",
                tools,
                source: {
                  agentId: "main",
                  sessionId: parent.sessionId,
                  lifecycleRevision: source?.lifecycleRevision ?? null,
                  creatorProfileId: alice.id,
                  root: source?.sessionRoot,
                },
              },
            },
          },
        });
        expect(entry?.sidebarRoot).not.toBe(true);
        expect(childRun()).toMatchObject({
          requiresCompletionAuthority: true,
          requesterSettleWake: { requesterYieldBatch: true },
        });
        const ids = { gate, parent: parent.key, child, profileId: carol.id, creator: alice.id };
        const trace = (phase: string, details: object) =>
          console.info(`DESCENDANT_${phase}`, JSON.stringify({ ...ids, ...details }));
        trace("ADMITTED", { stateRoot: state.root });
        if (gate === "approval") {
          const requested = (client: keyof typeof events) =>
            events[client].find((event) => event.event === "exec.approval.requested");
          await vi.waitFor(() => expect(requested("sender")).toBeDefined(), { timeout: 10_000 });
          const approval = requested("sender")!.payload as { id: string };
          expect(approval).toMatchObject({
            canDecide: true,
            request: {
              command: `printf ${proof}`,
              security: "allowlist",
              ask: "on-miss",
              turnActor: { id: carol.id },
            },
          });
          await rpc("invited", "chat.history", target);
          expect(requested("invited")).toBeUndefined();
          expect(requested("guest")).toBeUndefined();
          const decision = { id: approval.id, decision: "allow-once" };
          for (const method of ["exec.approval.resolve", "approval.resolve"]) {
            await expect(rpc("invited", method, decision)).rejects.toThrow();
          }
          expect(outputs).toEqual([]);
          await rpc("sender", "exec.approval.resolve", decision);
          await wait(child.runId);
          await vi.waitFor(() => expect(childRun()?.delivery?.status).toBe("delivered"), {
            timeout: 10_000,
          });
          expect(outputs).toEqual([expect.stringMatching(new RegExp(`(?:^|\\n)${proof}$`))]);
          trace("APPROVAL_PROOF", {
            approvalId: approval.id,
            outputs,
            providerCalls: calls.length,
          });
        } else {
          await send(activePrompt, "native-descendant-active-root");
          await withinTest(rootStarted.promise, signal);
          const before = providerRequests.length;
          restarting = true;
          recovered = createDeferred();
          await fixture.restart();
          await withinTest(recovered.promise, signal);
          await vi.waitFor(() => expect(childRun()?.execution.status).toBe("terminal"), {
            timeout: 10_000,
          });
          const restored = childRun()!;
          const receipt = await withinTest(resumed.promise, signal);
          const outcome = await withinTest(receipt.settled, signal);
          trace("RESTART_PROOF", {
            execution: restored.execution,
            receiptId: receipt.id,
            outcome,
            before,
            after: providerRequests.length,
            calls,
          });
          expect(restored.requiresCompletionAuthority).toBe(true);
          expect(restored.execution).toMatchObject({
            status: "terminal",
            outcome: { status: "error" },
          });
          expect(
            (await readSessionEntryReadOnlyInWorker(childScope))?.resumeAfterRestart,
          ).toBeUndefined();
          expect(calls.filter((call) => call.role === "child" && call.restarted)).toEqual([]);
          expect(outcome).toMatchObject({ status: "completed", executionStarted: true });
          expect(calls.some((call) => call.role === "root" && call.restarted)).toBe(true);
        }
        for (const call of calls) {
          expect(call.tools, JSON.stringify(call)).toEqual([...tools, "skills_read"].toSorted());
        }
      },
      {
        maxInvitedAccess: "send",
        invitedScopes: ["operator.sessions.read"],
        invitedTools: tools,
        tools: {
          allow: [...tools, "write"],
          toolSearch: false,
          codeMode: { enabled: false },
          exec: { host: "gateway", security: "full", ask: "off" },
        },
      },
    );
  });
}
