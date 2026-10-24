import { randomUUID } from "node:crypto";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import { CronStreamApprovalEndedError } from "../../cron/stream-approval-outcome.js";
import {
  CronStreamExecApprovalRequiredError,
  CronStreamPolicyDeniedError,
  cronStreamExecApprovalBinding,
  type CronStreamExecApproval,
  type CronStreamExecApprovalReceipt,
} from "../../cron/stream-exec-authority.js";
import {
  sanitizeExecApprovalDisplayTextWithStatus,
  sanitizeExecApprovalWarningTextWithStatus,
} from "../../infra/exec-approval-text-sanitize.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals-core.js";
import { formatExecCommand } from "../../infra/system-run-command.js";
import { handlePendingApprovalRequestWithDelivery } from "./approval-request-delivery.js";
import { bindApprovalRequesterMetadata } from "./approval-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/** Human waits happen after confirmed rollback, outside cron and SQLite locks. */
export async function withCronStreamExecApproval<T>(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  creatorSessionId: string | undefined;
  assertCurrent: () => void;
  sandboxContext?: SandboxContext;
  mutate: (approval?: CronStreamExecApproval) => Promise<T>;
  onApprovalCommitted?: (receipt: CronStreamExecApprovalReceipt) => void;
}): Promise<T> {
  const deadline = Date.now() + DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
  params.assertCurrent();
  let pendingError: unknown;
  try {
    return await params.mutate();
  } catch (error) {
    pendingError = error;
  }
  for (;;) {
    const error = pendingError;
    if (!(error instanceof CronStreamExecApprovalRequiredError) || !error.mutation) {
      throw error;
    }
    const manager = params.context.execApprovalManager;
    const identity = params.client?.internal?.agentRuntimeIdentity;
    const timeoutMs = deadline - Date.now();
    if (!manager || !identity || !params.creatorSessionId || timeoutMs <= 0) {
      throw new TypeError("Stream was not saved: user approval is unavailable or expired.");
    }
    params.assertCurrent();
    const mutation = error.mutation;
    const job = mutation.job;
    if (job.schedule.kind !== "stream") {
      throw error;
    }
    const binding = cronStreamExecApprovalBinding(mutation);
    const sandboxTarget = job.streamSandbox;
    const cwdValue = job.schedule.cwd ?? job.streamSandbox?.containerWorkdir ?? process.cwd();
    const execution: { assertCurrent: () => void; revalidate?: () => Promise<void> } = sandboxTarget
      ? await (async () => {
          if (!params.sandboxContext) {
            throw new CronStreamPolicyDeniedError(
              "Sandbox stream approval requires its original admitted sandbox.",
            );
          }
          const { prepareCronStreamSandboxApproval } =
            await import("../cron-stream-sandbox-approval.js");
          return await prepareCronStreamSandboxApproval({
            sandbox: params.sandboxContext,
            target: sandboxTarget,
          });
        })()
      : await (
          await import("../cron-stream-execution-binding.js")
        ).prepareCronStreamExecutionBinding({
          argv: job.schedule.command,
          cwd: cwdValue,
        });
    params.assertCurrent();
    const command = sanitizeExecApprovalDisplayTextWithStatus(
      formatExecCommand(job.schedule.command),
    );
    const cwd = sanitizeExecApprovalDisplayTextWithStatus(cwdValue);
    const outputAction =
      job.payload.kind === "agentTurn"
        ? `starts the agent task ${JSON.stringify(job.payload.message)}`
        : job.payload.kind === "systemEvent"
          ? `posts the session event ${JSON.stringify(job.payload.text)}`
          : "runs this automation's configured script";
    const outputSelection =
      job.schedule.mode === "match"
        ? `Output matching ${JSON.stringify(job.schedule.match)}`
        : "Each batch of output";
    const warning = sanitizeExecApprovalWarningTextWithStatus(
      `${mutation.method === "cron.add" ? "Create" : "Reactivate or change"} persistent stream ${JSON.stringify(job.name)}? ` +
        `Watcher ID: ${JSON.stringify(job.id)}. ` +
        (job.streamSandbox
          ? "Each start uses a fresh Docker container with this session's approved mounts and configured filesystem, network, and resource restrictions. " +
            "Sandbox setup runs each time; files outside those mounts are discarded between starts. It keeps running "
          : "It runs on your Gateway ") +
        "after this conversation ends and automatically restarts after interruptions, including Gateway restarts, until disabled or deleted. " +
        "Approve once authorizes this saved watcher and its automatic restarts. " +
        `${outputSelection} ${outputAction}. Notification delivery: ${job.delivery ? JSON.stringify(job.delivery) : "the session’s configured route"}.`,
    );
    if (
      command.truncated ||
      command.oversized ||
      cwd.truncated ||
      cwd.oversized ||
      warning.truncated ||
      warning.oversized
    ) {
      throw new TypeError(
        "Stream was not saved: its proposal is too large to display completely for approval.",
      );
    }
    const request = {
      command: command.text,
      commandArgv: [...job.schedule.command],
      cwd: cwd.text,
      host: job.streamSandbox ? "sandbox" : "gateway",
      security: error.security,
      ask: error.ask,
      allowedDecisions: ["allow-once", "deny"] as const,
      unavailableDecisions: ["allow-always"] as const,
      warningText: warning.text,
      streamProposal: {
        jobId: job.id,
        name: sanitizeExecApprovalDisplayTextWithStatus(job.name).text,
        operation: mutation.method === "cron.add" ? ("add" as const) : ("update" as const),
      },
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      sessionId: params.creatorSessionId,
      runId: identity.operationalRunInstance.runId,
      turnSourceChannel: identity.turnSourceChannel,
      turnSourceTo: identity.turnSourceTo,
      turnSourceAccountId: identity.turnSourceAccountId,
      turnSourceThreadId: identity.turnSourceThreadId,
    };
    const record = manager.create(request, timeoutMs, `cron-stream:${randomUUID()}`);
    record.agentRuntimeDelegatedAuthority = identity.delegatedAuthority;
    record.executionIdentityToken = identity.executionIdentity;
    record.approvalAuthority = params.assertCurrent;
    bindApprovalRequesterMetadata({ record, client: params.client });
    await manager.register(record, timeoutMs);
    let outcome:
      | { value: T; approval?: CronStreamExecApprovalReceipt }
      | { error: unknown }
      | undefined;
    await handlePendingApprovalRequestWithDelivery({
      approvalKind: "exec",
      manager,
      record,
      respond: () => {},
      context: params.context,
      twoPhase: false,
      requireDeliveryRoute: true,
      forwardRequest: params.context.forwardExecApprovalRequest,
      getIosPushDelivery: () => params.context.execApprovalIosPushDelivery,
      afterDecision: async (decision) => {
        try {
          params.assertCurrent();
          const assertOperatorDecision = () => {
            params.assertCurrent();
            const snapshot = manager.getLocalSnapshot(record.id);
            const ended = (terminalOutcome: "operator-denied" | "expired" | "cancelled") => {
              return new CronStreamApprovalEndedError({
                action: mutation.method === "cron.add" ? "add" : "update",
                approvalId: record.id,
                outcome: terminalOutcome,
              });
            };
            if (snapshot?.status === "expired") {
              throw ended("expired");
            }
            if (snapshot?.status === "cancelled") {
              throw ended("cancelled");
            }
            const operatorDecision = snapshot?.resolutionSource === "operator";
            if (
              operatorDecision &&
              snapshot?.status === "denied" &&
              snapshot.terminalReason === "user" &&
              decision === "deny"
            ) {
              throw ended("operator-denied");
            }
            if (
              !operatorDecision ||
              manager.projectDecisionIfActive(record.id, decision) !== "allow-once"
            ) {
              throw new TypeError("Stream was not saved: affirmative user approval is required.");
            }
          };
          assertOperatorDecision();
          await execution.revalidate?.();
          assertOperatorDecision();
          const consumption = manager.prepareConsumeAllowOnce(
            record.id,
            `cron.stream:${mutation.method}:${job.id}`,
          );
          if (!consumption) {
            throw new TypeError("Stream was not saved: approval is no longer active.");
          }
          let committedApproval: CronStreamExecApprovalReceipt | undefined;
          const value = await params.mutate({
            policyKey: error.policyKey,
            binding,
            createdAtMs: job.createdAtMs,
            consumption: {
              ...consumption,
              markCommitted: (committed) => {
                consumption.markCommitted(committed);
                committedApproval = {
                  approvalId: committed.id,
                  decision: "allow-once",
                  source: "operator",
                };
              },
              assertCurrent: () => {
                assertOperatorDecision();
                execution.assertCurrent();
                consumption.assertCurrent();
              },
            },
          });
          outcome = { value, ...(committedApproval ? { approval: committedApproval } : {}) };
        } catch (mutationError) {
          outcome = { error: mutationError };
        }
      },
    });
    if (!outcome) {
      throw new TypeError(
        "Stream was not saved: no approval was received. Retry from an approval-capable chat or client.",
      );
    }
    if ("error" in outcome) {
      pendingError = outcome.error;
      continue;
    }
    if (outcome.approval) {
      params.onApprovalCommitted?.(outcome.approval);
    }
    return outcome.value;
  }
}
