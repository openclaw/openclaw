import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { errorShapeFromError } from "./error-shape.js";
import { OperatorRefusalError, type OperatorRefusalCause } from "./operator-refusal.js";
import { unwrapGatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";

// Each refusal says what was not done, whose access stopped it and why, and one next step.
const SENTENCES = {
  "access-ended":
    "I did not start this request. Your access to this Gateway has ended. Ask a Gateway admin to restore it.",
  "sign-in-ended":
    "I did not start this request. The sign-in it was started with is no longer valid. Reconnect to the Gateway, then send your message again.",
  "role-denies":
    "I did not start this request. Your role on this Gateway does not allow it. Ask a Gateway admin to do it, or to add the permission to your role.",
  "channel-unverified":
    "I did not start this request. This channel cannot confirm who you are. Use Control UI, Discord or Telegram for this. If you are not the Gateway owner, ask an admin to link your channel account to your Gateway profile first.",
  "owner-removed":
    "I did not start this request. Your channel account is no longer listed as a Gateway owner. Ask the Gateway owner to add it back to commands.ownerAllowFrom, then send a new message.",
  "requester-access-ended":
    "I did not start this request. The access of the person who started it has ended. Ask them or a Gateway admin to restore that access, then start the task again.",
  "invitation-ended":
    "I did not start this request. The invitation you joined this session with has ended. Ask the session owner to invite you again.",
  "github-not-linked":
    "I did not start this request. Your Gateway profile has no linked GitHub account, so I cannot check that the PR is yours. Link it once in the Control UI under Settings → Profile → Identity, on the configured GitHub host, then ask again.",
} satisfies Record<OperatorRefusalCause, string>;

async function runRefusedTool(failure: () => unknown) {
  const [definition] = toToolDefinitions([
    {
      name: "github_publish",
      label: "github_publish",
      description: "test tool",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        failure();
        return { content: [], details: {} };
      },
    },
  ]);
  const result = await definition!.execute("call-1", {}, undefined, undefined, {} as never);
  return result.details;
}

describe("operator refusals", () => {
  it.each(Object.entries(SENTENCES) as [OperatorRefusalCause, string][])(
    "%s tells the person the next step and the model not to retry",
    async (cause, sentence) => {
      const refusal = new OperatorRefusalError(cause);
      expect(refusal.message).toBe(sentence);
      await expect(
        runRefusedTool(() => {
          throw refusal;
        }),
      ).resolves.toEqual({
        status: "error",
        tool: "github_publish",
        error: `${sentence} Do not retry.`,
      });
    },
  );

  it("keeps the refusal when a Gateway method returns it to an in-process tool", async () => {
    const refusal = new OperatorRefusalError("role-denies", {
      action: "run the merge action on this PR",
    });
    const response = {
      ok: false,
      error: errorShapeFromError(ErrorCodes.UNAVAILABLE, refusal, { message: refusal.message }),
    } as const;
    await expect(
      runRefusedTool(() => unwrapGatewayMethodDispatchResponse("sessions.github.action", response)),
    ).resolves.toMatchObject({
      error:
        "I did not run the merge action on this PR. Your role on this Gateway does not allow it. Ask a Gateway admin to do it, or to add the permission to your role. Do not retry.",
    });
  });
});
