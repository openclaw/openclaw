import { Type } from "typebox";
import {
  GitHubPublicationBodySchema,
  GitHubPublicationTitleSchema,
  GitHubPublicationReviewReferenceSchema,
  type SessionGitHubReviewResult,
  type SessionGitHubReviewDiffResult,
  type SessionGitHubPublicationResult,
  type SessionGitHubPublishParams,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

export function createGitHubPublishTool(
  options: {
    callGateway?: InProcessGatewayCaller;
  } = {},
): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "GitHub Publish",
    name: "github_publish",
    description:
      "Publish this session's repository changes as a draft pull request using the current maintainer's authority. For a restricted session, use action=prepare to capture an immutable candidate, action=diff to read every page of its exact diff and target, then action=confirm with its reviewId and digest when the maintainer has authorized that candidate. Review preparation grants no publication authority. Changed source, account or target requires a new review; a restart requires fresh confirmation. Cloud review selects the last accepted checkpoint, so finish edits before preparing it. A confirmation may finish after this turn saves an unchanged result; it never elevates the guest run. The Gateway posts the publication outcome into this conversation and keeps credentials out of its workspace. Ordinary unrestricted sessions also support action=publish. A publication receipt does not complete remaining review, CI or landing work.",
    parameters: Type.Object(
      {
        title: Type.Optional(GitHubPublicationTitleSchema),
        body: Type.Optional(GitHubPublicationBodySchema),
        action: Type.Optional(
          Type.Union([
            Type.Literal("publish"),
            Type.Literal("prepare"),
            Type.Literal("diff"),
            Type.Literal("confirm"),
          ]),
        ),
        review: Type.Optional(GitHubPublicationReviewReferenceSchema),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, rawArgs) => {
      // SAFETY: the tool runtime validates rawArgs against the closed schema above.
      const input = rawArgs as Omit<SessionGitHubPublishParams, "idempotencyKey" | "sessionKey"> & {
        action?: "publish" | "prepare" | "diff" | "confirm";
        offset?: number;
      };
      const caller = getGatewayToolCallerIdentity();
      if (!caller?.sessionKey) {
        throw new Error("GitHub publication requires the current Gateway session.");
      }
      if (input.action === "prepare") {
        const result = await callGateway<SessionGitHubReviewResult>("sessions.github.review", {
          sessionKey: caller.sessionKey,
          action: "prepare",
          idempotencyKey: toolCallId,
          ...(input.title ? { title: input.title } : {}),
          ...(input.body ? { body: input.body } : {}),
        });
        // The submitted body is already in context. Only explicit diff reads return source data.
        const { body: _body, ...metadata } = result;
        return jsonResult(metadata);
      }
      if (input.action === "diff") {
        if (!input.review || input.offset === undefined) {
          throw new Error(
            "Diff review requires reviewId, digest and an explicit offset; start at 0 and follow nextOffset until complete.",
          );
        }
        return jsonResult(
          await callGateway<SessionGitHubReviewDiffResult>("sessions.github.review", {
            sessionKey: caller.sessionKey,
            action: "diff",
            ...input.review,
            offset: input.offset,
          }),
        );
      }
      if (input.action === "confirm" && !input.review) {
        throw new Error(
          "Confirm requires the reviewed candidate's reviewId and digest. Prepare and read its complete diff first.",
        );
      }
      const result = await callGateway<SessionGitHubPublicationResult>("sessions.github.publish", {
        sessionKey: caller.sessionKey,
        idempotencyKey: toolCallId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.body ? { body: input.body } : {}),
        ...(input.action === "confirm" ? { review: input.review } : {}),
      });
      return jsonResult(result);
    },
  };
}
