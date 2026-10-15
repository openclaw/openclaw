import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  drainSessionToolsFixture,
  withSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { roleClient } from "./session-sharing.test-utils.js";

const createAgentTurnService = vi.hoisted(() =>
  vi.fn<typeof import("./agent-turn/agent-turn-service.js").createAgentTurnService>(),
);
// mock-isolation: Stop at inference; tool preparation, scope projection, router authorization,
// target ownership, request validation, and source identity use their production owners.
vi.mock("./agent-turn/agent-turn-service.js", () => ({ createAgentTurnService }));

const PARENT = "agent:main:dashboard:followup-parent";
const CHILD = "agent:main:dashboard:followup-child";
const FOREIGN = "agent:main:dashboard:followup-foreign";

async function withFollowup(
  run: (fixture: {
    send: (sessionKey?: string) => Promise<unknown>;
    revoke: () => void;
    profileId: string;
  }) => Promise<void>,
) {
  await withSessionToolsFixture(async (cfg) => {
    const role = expectDefined(cfg.gateway?.roles?.definitions?.view, "guest role");
    role.scopes = ["operator.sessions.read", "operator.sessions.write"];
    role.sandbox = "required";
    const client = roleClient("view", "followup-owner");
    client.connect.scopes = [...role.scopes];
    const profileId = expectDefined(client.authenticatedUserProfile, "original person").profileId;
    for (const [sessionKey, sessionId, creatorId] of [
      [PARENT, "followup-parent-session", profileId],
      [CHILD, "followup-child-session", profileId],
      [FOREIGN, "followup-foreign-session", "another-person"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          lifecycleRevision: "retained-generation",
          updatedAt: 1,
          visibility: "shared",
          status: "done",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: creatorId },
          sandbox: "required",
          ...(sessionKey === CHILD
            ? { spawnedBy: PARENT, parentSessionId: "followup-parent-session" }
            : {}),
        },
      );
    }
    const context = expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "Gateway");
    const source = new AbortController();
    const captured = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: source.signal,
          assertCurrent: () => source.signal.throwIfAborted(),
        },
      }),
      "guest authority",
    );
    try {
      await withPersonalToolTurn(
        {
          owner: {
            profileId,
            senderId: "followup-owner",
            name: "Followup owner",
            operatorAuthority: captured.authority,
          },
          sessionKey: PARENT,
          sessionId: "followup-parent-session",
        },
        async () => {
          const tool = createSessionsSendTool({
            config: cfg,
            agentSessionKey: PARENT,
            completionOwner: "caller",
          });
          await run({
            send: (sessionKey = CHILD) =>
              tool.execute("followup-child", {
                sessionKey,
                mode: "followup",
                message: "Continue the retained review.",
                timeoutSeconds: 0,
              }),
            revoke: () => source.abort(new Error("followup source revoked")),
            profileId,
          });
        },
      );
    } finally {
      captured.release();
    }
  });
}

describe("guest session followup admission", () => {
  afterEach(async () => {
    createAgentTurnService.mockReset();
    await drainSessionToolsFixture();
  });

  it("continues the owned child with the original narrow authority while raw agent calls stay denied", async () => {
    await withFollowup(async ({ send, profileId }) => {
      const started = vi.fn();
      createAgentTurnService.mockReturnValue({
        startTurn: async ({ principal, preflight, io, assertAdmissionCurrent }) => {
          assertAdmissionCurrent?.();
          expect(principal?.connect.scopes).toEqual(["operator.sessions.write"]);
          expect(principal?.internal?.operatorRoleActor).toEqual({ kind: "operator", profileId });
          expect(preflight.request).toMatchObject({
            sessionKey: CHILD,
            expectedExistingSessionId: "followup-child-session",
            expectedExistingSessionLifecycleRevision: "retained-generation",
          });
          started();
          io.emitAcceptance([true, { status: "accepted", runId: "child-followup-run" }, undefined]);
        },
        prepareWaitForTurn: vi.fn(),
        waitForTurn: vi.fn(),
      });
      await expect(send()).resolves.toMatchObject({
        details: { status: "accepted", runId: "child-followup-run" },
      });
      expect(started).toHaveBeenCalledOnce();
      await expect(
        dispatchGatewayMethodInProcess("agent", {
          sessionKey: CHILD,
          expectedExistingSessionId: "followup-child-session",
          expectedExistingSessionLifecycleRevision: "retained-generation",
          message: "Unbound input",
          idempotencyKey: "unbound-run",
        }),
      ).rejects.toThrow("missing scope: operator.write");
      expect(started).toHaveBeenCalledOnce();
    });
  });

  it("rejects an unrelated target before starting a turn", async () => {
    await withFollowup(async ({ send }) => {
      await expect(send(FOREIGN)).resolves.toMatchObject({ details: { status: "forbidden" } });
      expect(createAgentTurnService).not.toHaveBeenCalled();
    });
  });

  it("keeps the source authority fence before turn execution", async () => {
    await withFollowup(async ({ send, revoke }) => {
      const started = vi.fn();
      createAgentTurnService.mockReturnValue({
        startTurn: async ({ assertAdmissionCurrent }) => {
          revoke();
          assertAdmissionCurrent?.();
          started();
        },
        prepareWaitForTurn: vi.fn(),
        waitForTurn: vi.fn(),
      });
      await expect(send()).rejects.toThrow("Followup owner's access changed; ask them again");
      expect(started).not.toHaveBeenCalled();
    });
  });
});
