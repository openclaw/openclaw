import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { loadCronJobsStore } from "../cron/store.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";

it("readmits the original invitation before a model-created scheduled occurrence", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ sender, invited, carol, providerReplies, providerRequests }) => {
      const { key } = await sender.request<{ key: string }>(
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
      providerReplies.reply = undefined;
      await sender.request(
        "session.members.remove",
        { ...target, identityId: carol.id },
        { signal },
      );
      const before = providerRequests.length;
      const receipt = await sender.request(
        "cron.run",
        { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
        { signal },
      );
      expect(receipt).toMatchObject({
        run: { status: "error", error: expect.stringContaining("authority") },
      });
      expect(providerRequests).toHaveLength(before);
      await sender.request(
        "session.members.add",
        { ...target, identityId: carol.id, access: "send" },
        { signal },
      );
      const resumed = await sender.request(
        "cron.run",
        { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
        { signal },
      );
      expect(resumed).toMatchObject({ run: { status: "ok" } });
      expect(providerRequests.length).toBeGreaterThan(before);
      await sender.request("cron.remove", { id: job.id }, { signal });
    },
    {
      maxInvitedAccess: "send",
      invitedScopes: ["operator.sessions.read", "operator.cron"],
      invitedTools: ["automations", "read"],
      tools: { allow: ["automations", "read"], codeMode: { enabled: false }, toolSearch: false },
    },
  );
});
