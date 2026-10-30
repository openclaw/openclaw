import { expect, it, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CronDeliveryPreview } from "../../cron/types.js";
import {
  agentTurnCronParams,
  createCronCallerClient as callerClient,
  type createCronTestInvoker,
  expectCronSuccess,
  expectResponseError,
  requireCronAddPayload,
  requireRecord,
} from "./cron.validation.test-support.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import type { GatewayClient } from "./types.js";

export type CronCreatorSessionLookup = {
  canonicalKey: string;
  entry?: Partial<Record<"agentHarnessId" | "modelSelectionLocked" | "sessionId", unknown>> &
    Pick<SessionEntry, "createdActor" | "lifecycleRevision" | "skillLibrarySelections">;
};

export function registerCronCreatorSessionTests(fixture: {
  invokeCron: ReturnType<typeof createCronTestInvoker>;
  loadGatewaySessionEntry: Mock<(sessionKey: string) => CronCreatorSessionLookup>;
  resolveCronDeliveryPreview: Mock<() => Promise<CronDeliveryPreview>>;
}) {
  const { invokeCron, loadGatewaySessionEntry, resolveCronDeliveryPreview } = fixture;
  const creator = { type: "human", source: "profile", id: "profile-ada" } as const;
  const sourceConversation = {
    sessionKey: "agent:ops:conversation",
    sessionId: "creating-session",
    lifecycleRevision: "generation-1",
  };
  const create = async (
    params: Parameters<typeof invokeCron>[1],
    options?: Parameters<typeof invokeCron>[2],
  ) => {
    const { context, respond } = await invokeCron("cron.add", params, options);
    expectCronSuccess(respond);
    return {
      options: requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options"),
      payload: requireCronAddPayload(context),
    };
  };
  it("stamps the authenticated profile as private cron creator provenance", async () => {
    const { authenticatedUserProfile } = createSessionMutationTestClient("profile-ada");
    const client = { connect: {} as GatewayClient["connect"], authenticatedUserProfile };

    const { options, payload } = await create(agentTurnCronParams(), { client });
    expect(options.createdActor).toEqual(creator);
    expect(payload).not.toHaveProperty("createdActor");
  });

  it.each([
    ["agent-runtime", { kind: "agentTurn", message: "report", toolsAllow: ["*"] }],
    ["operator", { kind: "agentTurn", message: "report", toolsAllow: ["*"] }],
    ["operator", { kind: "script", script: "return { notify: 'report' };", toolsAllow: [] }],
    ["operator", { kind: "command", argv: ["echo", "report"] }],
  ])("retains %s creator context for %j", async (caller, jobPayload) => {
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: sourceConversation.sessionKey,
      entry: {
        ...sourceConversation,
        createdActor: { ...creator },
        skillLibrarySelections: [],
      },
    });
    const { options, payload } = await create(
      agentTurnCronParams({ agentId: "ops", sessionKey: "conversation", payload: jobPayload }),
      caller === "agent-runtime"
        ? { client: callerClient("ops", undefined, sourceConversation.sessionKey) }
        : undefined,
    );

    expect(options.sourceConversation).toEqual(sourceConversation);
    if (caller === "operator") {
      expect(options).not.toHaveProperty("skillLibrarySelections");
      expect(options).not.toHaveProperty("createdActor");
    } else {
      expect(options.skillLibrarySelections).toEqual([]);
      // Historical isolation identity is retained, but no human initiated this runtime call.
      expect(options.createdActor).toEqual({
        ...creator,
        delegatedBy: { type: "agent", id: "ops" },
      });
    }
    expect(payload).not.toHaveProperty("sourceConversation");
    expect(resolveCronDeliveryPreview).toHaveBeenCalledWith(
      expect.objectContaining({ job: expect.objectContaining({ sourceConversation }) }),
    );
  });

  it("retains the creator incarnation for main-session reminders", async () => {
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: sourceConversation.sessionKey,
      entry: { ...sourceConversation, createdActor: creator },
    });
    const { options, payload } = await create(
      agentTurnCronParams({
        agentId: "ops",
        sessionKey: "conversation",
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "Synthetic reminder" },
      }),
      { client: callerClient("ops", undefined, sourceConversation.sessionKey) },
    );

    expect(options.ownerSessionId).toBe(sourceConversation.sessionId);
    expect(options.payloadSourceConversation).toEqual(sourceConversation);
    expect(options).not.toHaveProperty("sourceConversation");
    expect(payload).not.toHaveProperty("ownerSessionId");
    expect(payload).not.toHaveProperty("payloadSourceConversation");
  });

  it.each([undefined, "missing-conversation"])(
    "leaves isolated jobs unbound without an existing creating session: %s",
    async (sessionKey) => {
      const { options } = await create(agentTurnCronParams({ sessionKey }));
      expect(options).not.toHaveProperty("sourceConversation");
    },
  );

  it("retains unknown isolation provenance without attributing agent-created cron jobs to a human", async () => {
    const legacyCreator = { ...creator, source: "unknown", label: "Ada" } as const;
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: "agent:ops:main",
      entry: {
        sessionId: "session-ops-main",
        createdActor: { ...legacyCreator },
      },
    });
    const client = callerClient("ops");
    client.internal!.agentRuntimeIdentity!.sessionSpawnContext = {
      inheritedToolPolicy: { version: 1, allow: ["*"], deny: [] },
    };

    const { options, payload } = await create(agentTurnCronParams(), { client });
    expect(options.createdActor).toEqual({
      ...legacyCreator,
      delegatedBy: { type: "agent", id: "ops" },
    });
    expect(loadGatewaySessionEntry).toHaveBeenCalledWith("agent:ops:main", { agentId: "ops" });
    expect(payload).not.toHaveProperty("createdActor");
  });

  it.each([
    { createdActor: { type: "human", source: "profile", id: "spoofed-profile" } },
    {
      payloadSourceConversation: {
        sessionKey: "agent:main:other",
        sessionId: "spoofed-session",
      },
    },
    { sourceConversation: { sessionKey: "agent:main:other", sessionId: "spoofed-session" } },
    { operatorSource: { source: { profileId: "spoofed-profile" } } },
  ])("rejects caller-supplied private cron creator facts: %j", async (privateFields) => {
    const { context, respond } = await invokeCron("cron.add", agentTurnCronParams(privateFields));

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST" });
  });
}
