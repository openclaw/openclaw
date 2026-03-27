import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const MctlAgentExternalActions = ["claim", "result"] as const;
const MctlAgentResultStatuses = ["pr_created", "needs_human", "failed", "declined"] as const;

const MctlAgentExternalToolSchema = Type.Object({
  action: stringEnum(MctlAgentExternalActions),
  claimUrl: Type.Optional(Type.String()),
  resultUrl: Type.Optional(Type.String()),
  callbackAuthHeader: Type.Optional(Type.String()),
  callbackAuthValue: Type.String(),
  agentId: Type.String(),
  eventId: Type.String(),
  leaseId: Type.Optional(Type.String()),
  idempotencyKey: Type.Optional(Type.String()),
  status: Type.Optional(stringEnum(MctlAgentResultStatuses)),
  summary: Type.Optional(Type.String()),
  prUrl: Type.Optional(Type.String()),
  prNumber: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  prRepo: Type.Optional(Type.String()),
  prBranch: Type.Optional(Type.String()),
  prCommitSha: Type.Optional(Type.String()),
  logsUrl: Type.Optional(Type.String()),
  messageTemplate: Type.Optional(Type.String()),
});

function readRequiredHttpUrl(params: Record<string, unknown>, key: string): string {
  const url = readStringParam(params, key, { required: true, label: key });
  if (!/^https?:\/\//i.test(url)) {
    throw new ToolInputError(`${key} must start with http:// or https://`);
  }
  return url;
}

export function createMctlAgentExternalTool(): AnyAgentTool {
  return {
    label: "MCTL Agent External",
    name: "mctl_agent_external",
    description:
      "Claim mctl-agent external tickets and send structured result callbacks for mctl-agent webhook incidents.",
    parameters: MctlAgentExternalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const callbackAuthHeader = readStringParam(params, "callbackAuthHeader") ?? "Authorization";
      const callbackAuthValue = readStringParam(params, "callbackAuthValue", {
        required: true,
        label: "callbackAuthValue",
      });
      const agentId = readStringParam(params, "agentId", { required: true, label: "agentId" });
      const eventId = readStringParam(params, "eventId", { required: true, label: "eventId" });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        [callbackAuthHeader]: callbackAuthValue,
      };

      if (action === "claim") {
        const claimUrl = readRequiredHttpUrl(params, "claimUrl");
        const response = await fetch(claimUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent_id: agentId,
            event_id: eventId,
          }),
        });
        const text = await response.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          // keep raw text
        }
        return jsonResult({
          ok: response.ok,
          statusCode: response.status,
          body,
        });
      }

      if (action === "result") {
        const resultUrl = readRequiredHttpUrl(params, "resultUrl");
        const leaseId = readStringParam(params, "leaseId", { required: true, label: "leaseId" });
        const idempotencyKey = readStringParam(params, "idempotencyKey", {
          required: true,
          label: "idempotencyKey",
        });
        const status = readStringParam(params, "status", { required: true, label: "status" });
        const summary = readStringParam(params, "summary") ?? "";
        const prUrl = readStringParam(params, "prUrl");
        const prNumber = params.prNumber;
        const prRepo = readStringParam(params, "prRepo");
        const prBranch = readStringParam(params, "prBranch");
        const prCommitSha = readStringParam(params, "prCommitSha");
        const logsUrl = readStringParam(params, "logsUrl");
        const messageTemplate = readStringParam(params, "messageTemplate");

        const artifacts: Record<string, string> = {};
        if (prUrl) {
          artifacts.pr_url = prUrl;
        }
        if (typeof prNumber === "string" && prNumber.trim() !== "") {
          artifacts.pr_number = prNumber.trim();
        } else if (typeof prNumber === "number" && Number.isFinite(prNumber)) {
          artifacts.pr_number = String(prNumber);
        }
        if (prRepo) {
          artifacts.repo = prRepo;
        }
        if (prBranch) {
          artifacts.branch = prBranch;
        }
        if (prCommitSha) {
          artifacts.commit_sha = prCommitSha;
        }
        if (logsUrl) {
          artifacts.logs_url = logsUrl;
        }

        const response = await fetch(resultUrl, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            agent_id: agentId,
            event_id: eventId,
            lease_id: leaseId,
            idempotency_key: idempotencyKey,
            status,
            summary,
            artifacts,
            message_template: messageTemplate,
          }),
        });
        const text = await response.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          // keep raw text
        }
        return jsonResult({
          ok: response.ok,
          statusCode: response.status,
          body,
        });
      }

      throw new ToolInputError("action must be claim or result");
    },
  };
}
