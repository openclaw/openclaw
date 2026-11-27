// Compile native runtime owners before the bounded fixture starts.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { SessionEventReceipt } from "../auto-reply/reply/session-event-contract.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import { removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { loadCronJobsStore } from "../cron/store.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import { readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import * as cronNotifications from "./server-cron-notifications.js";
import * as restartResume from "./session-restart-resume.js";

it("readmits persisted participant work after restart without substituting the creator", async ({
  signal,
}) => {
  const enqueue = sessionEvents.enqueueSessionEventForHost;
  const resumedRoot = createDeferred<SessionEventReceipt>();
  using eventObserver = vi
    .spyOn(sessionEvents, "enqueueSessionEventForHost")
    .mockImplementation((...args) => {
      const receipt = enqueue(...args);
      if (args[1].source === "restart") {
        resumedRoot.resolve(receipt);
      }
      return receipt;
    });
  void eventObserver;
  const resume = restartResume.resumeMarkedSessions;
  let recovery = createDeferred();
  using observer = vi
    .spyOn(restartResume, "resumeMarkedSessions")
    .mockImplementation(async (params) => {
      try {
        await resume(params);
      } finally {
        recovery.resolve();
      }
    });
  void observer;
  const createRepair = cronNotifications.createGatewayCronFailureRepair;
  let repairSettled = createDeferred();
  using repairObserver = vi
    .spyOn(cronNotifications, "createGatewayCronFailureRepair")
    .mockImplementation((...args) => {
      const owner = createRepair(...args);
      return {
        ...owner,
        runCronFailureRepair: async (request) => {
          try {
            await owner.runCronFailureRepair(request);
          } finally {
            repairSettled.resolve();
          }
        },
      };
    });
  void repairObserver;
  await withInvitedGuestGateway(
    signal,
    async (fixture) => {
      const { sender, invited, carol, providerReplies, providerRequests, state } = fixture;
      await withinTest(recovery.promise, signal);
      const { key, sessionId } = await sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        { agentId: "main", label: "Scheduled participation", visibility: "shared" },
        { signal },
      );
      const target = { agentId: "main", sessionKey: key };
      await sender.request(
        "session.members.add",
        { ...target, identityId: carol.id, access: "send" },
        { signal },
      );
      let step = 0;
      const outputs: string[] = [];
      providerReplies.reply = (body, response) => {
        const input = (JSON.parse(body) as { input: Array<{ type?: string; output?: string }> })
          .input;
        const output = input.findLast((item) => item.type === "function_call_output")?.output;
        if (output) {
          outputs.push(output);
        }
        if (step++ === 0) {
          writeToolCall(response, "automations", {
            action: "plan",
            names: ["Retained invitation"],
          });
        } else if (step === 2) {
          writeToolCall(response, "automations", {
            action: "add",
            job: {
              name: "Retained invitation",
              schedule: { kind: "at", at: new Date(Date.now() + 86_400_000).toISOString() },
              sessionTarget: `session:${key}`,
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "INVITATION_OCCURRENCE_PROOF" },
              delivery: { mode: "none" },
            },
          });
        } else {
          writeOpenAiResponsesText(response, {
            text: "Automation saved.",
            messageId: "schedule-reply",
            responseId: "schedule-response",
          });
        }
      };
      await invited.request(
        "chat.send",
        {
          ...target,
          message: "Create the requested one-time automation in this conversation.",
          idempotencyKey: "participant-schedule",
        },
        { signal },
      );
      await expect(
        sender.request("agent.wait", { runId: "participant-schedule" }, { signal }),
      ).resolves.toMatchObject({ status: "ok" });
      const jobs = (await loadCronJobsStore()).jobs;
      expect(jobs, JSON.stringify(outputs)).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.operatorSource?.source.snapshot.participationCeiling).toMatchObject({
        profileId: carol.id,
        sessionKey: key,
        source: { agentId: "main" },
      });
      // With send retained, startup resumes the requester, never the creator.
      const resumeReached = createDeferred();
      const queuedModel = createDeferred();
      const resumeTools: string[][] = [];
      let restarting = false;
      providerReplies.reply = (body, response) => {
        const request = JSON.parse(body) as { tools: { name: string }[] };
        if (restarting) {
          resumeTools.push(request.tools.map(({ name }) => name).toSorted());
          const queued = body.includes("PARTICIPANT_QUEUED_SUPPORTED");
          if (queued) {
            queuedModel.resolve();
          }
          writeOpenAiResponsesText(response, {
            text: queued ? "PARTICIPANT_QUEUE_RESUMED" : "PARTICIPANT_ROOT_RESUMED",
            messageId: `resumed-${resumeTools.length}`,
            responseId: `resumed-response-${resumeTools.length}`,
          });
        } else {
          resumeReached.resolve();
        }
      };
      await fixture.invited.request(
        "chat.send",
        {
          ...target,
          message: "PARTICIPANT_SUPPORTED_RESUME",
          idempotencyKey: "participant-supported-resume",
        },
        { signal },
      );
      await withinTest(resumeReached.promise, signal);
      await fixture.invited.request(
        "chat.send",
        {
          ...target,
          message: "PARTICIPANT_QUEUED_SUPPORTED",
          queueMode: "followup",
          idempotencyKey: "participant-queued-supported",
        },
        { signal },
      );
      restarting = true;
      recovery = createDeferred();
      await fixture.restart(async () => {
        const database = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
        const [stored] = readClosedDatabase(
          database,
          "SELECT entry_json FROM session_nodes WHERE session_key = ?",
          key,
        );
        expect(JSON.parse(String(stored!.entry_json)).resumeAfterRestart).toMatchObject({
          operatorSource: {
            kind: "gateway",
            snapshot: { profileId: carol.id, participationCeiling: { sessionKey: key } },
          },
        });
      });
      await withinTest(recovery.promise, signal);
      const rootReceipt = await withinTest(resumedRoot.promise, signal);
      const rootOutcome = await withinTest(rootReceipt.settled, signal);
      expect(rootOutcome).toMatchObject({
        status: "completed",
        executionStarted: true,
        summary: "PARTICIPANT_ROOT_RESUMED",
      });
      await withinTest(queuedModel.promise, signal);
      expect(
        await fixture.sender.request(
          "agent.wait",
          { runId: "participant-queued-supported" },
          { signal },
        ),
      ).toMatchObject({ status: "ok" });
      expect(
        (await listSessionPendingInputs({ ...target, sessionId })).items.find(
          ({ runId }) => runId === "participant-queued-supported",
        ),
      ).toBeUndefined();
      const recoveredHistory = await fixture.sender.request<{ messages: unknown[] }>(
        "chat.history",
        target,
        { signal },
      );
      expect(JSON.stringify(recoveredHistory.messages)).toContain("PARTICIPANT_QUEUED_SUPPORTED");
      expect(JSON.stringify(recoveredHistory.messages)).toContain("PARTICIPANT_ROOT_RESUMED");
      expect(JSON.stringify(recoveredHistory.messages)).toContain("PARTICIPANT_QUEUE_RESUMED");
      expect(resumeTools).toHaveLength(2);
      expect(
        resumeTools.every(
          (tools) =>
            JSON.stringify(tools) === JSON.stringify(["automations", "read", "skills_read"]),
        ),
      ).toBe(true);
      expect(
        (await readSessionEntryReadOnlyInWorker(target))?.delegatedOperatorSource,
      ).toBeUndefined();
      providerReplies.reply = undefined;
      const beforeCreator = providerRequests.length;
      await fixture.sender.request(
        "chat.send",
        { ...target, message: "CREATOR_CONTROL", idempotencyKey: "creator-control" },
        { signal },
      );
      await expect(
        fixture.sender.request("agent.wait", { runId: "creator-control" }, { signal }),
      ).resolves.toMatchObject({ status: "ok" });
      expect(
        (JSON.parse(providerRequests[beforeCreator]!) as { tools: { name: string }[] }).tools.map(
          ({ name }) => name,
        ),
      ).toContain("write");

      // Public chat ingress, not injected queue rows, owns both persisted sources.
      const held = createDeferred();
      providerReplies.reply = (_body, _response) => held.resolve();
      await fixture.invited.request(
        "chat.send",
        {
          ...target,
          message: "PARTICIPANT_ROOT_BEFORE_RESTART",
          idempotencyKey: "participant-root-restart",
        },
        { signal },
      );
      await withinTest(held.promise, signal);
      await fixture.invited.request(
        "chat.send",
        {
          ...target,
          message: "PARTICIPANT_QUEUED_BEFORE_RESTART",
          queueMode: "followup",
          idempotencyKey: "participant-queued-restart",
        },
        { signal },
      );
      let inputId = "";
      await vi.waitFor(async () => {
        const pending = await listSessionPendingInputs({ ...target, sessionId });
        const row = pending.items.find((item) => item.runId === "participant-queued-restart");
        expect(row?.state).toBe("queued");
        inputId = row!.id;
      });
      const beforeRestart = providerRequests.length;
      await withinTest(recovery.promise, signal);
      recovery = createDeferred();
      await fixture.restart(async () => {
        const database = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
        const [stored] = readClosedDatabase(
          database,
          "SELECT entry_json FROM session_nodes WHERE session_key = ?",
          key,
        );
        expect(JSON.parse(String(stored!.entry_json)).resumeAfterRestart).toMatchObject({
          operatorSource: {
            kind: "gateway",
            snapshot: {
              profileId: carol.id,
              participationCeiling: { profileId: carol.id, sessionKey: key },
            },
          },
        });
        const [queued] = readClosedDatabase(
          database,
          "SELECT state, origin_source_json FROM session_pending_inputs WHERE input_id = ?",
          inputId,
        );
        expect(queued?.state).toBe("queued");
        expect(JSON.parse(String(queued?.origin_source_json))).toMatchObject({
          kind: "gateway",
          snapshot: { profileId: carol.id, participationCeiling: { sessionKey: key } },
        });
        expect(await removeSessionMember(target, carol.id)).not.toBeNull();
        await closeOpenClawAgentDatabasesAsync();
        providerReplies.reply = undefined;
      });
      await withinTest(recovery.promise, signal);
      await vi.waitFor(async () => {
        const pending = await listSessionPendingInputs({ ...target, sessionId });
        expect(pending.items.find((item) => item.id === inputId)).toMatchObject({
          state: "cancelled",
          endCause: "revoked",
        });
        const history = await fixture.sender.request("chat.history", target, { signal });
        expect(JSON.stringify(history)).toContain("this run could not resume");
      });
      expect(providerRequests).toHaveLength(beforeRestart);
      expect((await loadCronJobsStore()).jobs[0]?.operatorSource).toEqual(job.operatorSource);
      const activeSender = fixture.sender;
      const before = providerRequests.length;
      const receipt = await activeSender.request(
        "cron.run",
        { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
        { signal },
      );
      expect(receipt).toMatchObject({
        run: { status: "error", error: expect.stringContaining("authority") },
      });
      await withinTest(repairSettled.promise, signal);
      expect
        .soft(
          providerRequests.slice(before).map((body) => ({
            repair: body.includes("Automation repair request from the scheduler"),
            tools: (JSON.parse(body) as { tools: { name: string }[] }).tools.map(
              ({ name }) => name,
            ),
          })),
          "removed membership must refuse repair before the provider",
        )
        .toEqual([]);
      await activeSender.request(
        "session.members.add",
        { ...target, identityId: carol.id, access: "send" },
        { signal },
      );
      for (const access of ["read", "suggest"] as const) {
        await activeSender.request(
          "session.members.setAccess",
          { ...target, identityId: carol.id, access },
          { signal },
        );
        repairSettled = createDeferred();
        const beforeDowngrade = providerRequests.length;
        const refused = await activeSender.request(
          "cron.run",
          { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
          { signal },
        );
        expect(refused).toMatchObject({
          run: { status: "error", error: expect.stringContaining("authority") },
        });
        await withinTest(repairSettled.promise, signal);
        expect.soft(providerRequests.length, access).toBe(beforeDowngrade);
      }
      await activeSender.request(
        "session.members.setAccess",
        { ...target, identityId: carol.id, access: "send" },
        { signal },
      );
      const resumed = await activeSender.request(
        "cron.run",
        { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
        { signal },
      );
      expect(resumed).toMatchObject({ run: { status: "ok" } });
      expect(providerRequests.length).toBeGreaterThan(before);
      await activeSender.request("cron.remove", { id: job.id }, { signal });
      console.info(
        "participation-recovery-proof",
        JSON.stringify({
          sessionKey: key,
          sessionId,
          jobId: job.id,
          revokedInputId: inputId,
          rootResumeInputId: rootReceipt.id,
          rootOutcome,
          retainedResumeProviderRequests: resumeTools.length,
          beforeRevokedRestart: beforeRestart,
          beforeRemovedOccurrence: before,
          finalProviderRequests: providerRequests.length,
          removedOccurrence: receipt,
          regrantedOccurrence: resumed,
        }),
      );
    },
    {
      maxInvitedAccess: "send",
      invitedScopes: ["operator.sessions.read", "operator.cron"],
      invitedTools: ["automations", "read"],
      tools: {
        allow: ["automations", "read", "write"],
        codeMode: { enabled: false },
        toolSearch: false,
      },
    },
  );
});
