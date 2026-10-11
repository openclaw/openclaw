import { expect, it, type Mock } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CronDeliveryPreview } from "../../cron/types.js";
import {
  agentTurnCronParams,
  createCronCallerClient as callerClient,
  type createCronTestContext,
  type createCronTestInvoker,
  expectCronSuccess,
  expectResponseError,
  requireCronAddPayload,
  requireRecord,
} from "./cron.validation.test-support.js";
import type { GatewayClient } from "./types.js";

export type CronCreatorSessionLookup = {
  canonicalKey: string;
  entry?: {
    agentHarnessId?: unknown;
    createdActor?: SessionCreatedActor;
    createdVia?: SessionEntry["createdVia"];
    modelSelectionLocked?: unknown;
    sessionId?: unknown;
    lifecycleRevision?: string;
    skillLibrarySelections?: SessionEntry["skillLibrarySelections"];
  };
};

export function registerCronCreatorSessionTests(fixture: {
  createCronContext: () => ReturnType<typeof createCronTestContext>;
  invokeCron: ReturnType<typeof createCronTestInvoker>;
  loadGatewaySessionEntry: Mock<(sessionKey: string) => CronCreatorSessionLookup>;
  resolveCronDeliveryPreview: Mock<() => Promise<CronDeliveryPreview>>;
}) {
  const { createCronContext, invokeCron, loadGatewaySessionEntry, resolveCronDeliveryPreview } =
    fixture;
  it("stamps the authenticated profile as private cron creator provenance", async () => {
    const client: GatewayClient = {
      connect: {} as GatewayClient["connect"],
      authenticatedUserProfile: {
        profileId: "profile-ada",
        displayName: "Ada",
        hasAvatar: false,
        updatedAt: 1,
      },
    };

    const { context, respond } = await invokeCron("cron.add", agentTurnCronParams(), { client });

    const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
    expect(options.createdActor).toEqual({ type: "human", source: "profile", id: "profile-ada" });
    expect(requireCronAddPayload(context)).not.toHaveProperty("createdActor");
    expectCronSuccess(respond);
  });

  it.each(["agent-runtime", "operator"] as const)(
    "binds isolated delivery to the canonical creating conversation for %s",
    async (caller) => {
      const sourceConversation = {
        sessionKey: "agent:ops:conversation",
        sessionId: "creating-session",
        lifecycleRevision: "generation-1",
      };
      loadGatewaySessionEntry.mockReturnValue({
        canonicalKey: sourceConversation.sessionKey,
        entry: {
          ...sourceConversation,
          createdActor: { type: "human", source: "profile", id: "profile-ada" },
          skillLibrarySelections: [],
        },
      });
      const { context, respond } = await invokeCron(
        "cron.add",
        agentTurnCronParams({ agentId: "ops", sessionKey: "conversation" }),
        caller === "agent-runtime"
          ? { client: callerClient("ops", undefined, sourceConversation.sessionKey) }
          : undefined,
      );

      const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
      expect(options.sourceConversation).toEqual(sourceConversation);
      if (caller === "operator") {
        expect(options).not.toHaveProperty("skillLibrarySelections");
        expect(options).not.toHaveProperty("createdActor");
      } else {
        expect(options.skillLibrarySelections).toEqual([]);
        expect(options.createdActor).toEqual({ type: "agent", id: "ops" });
      }
      expect(requireCronAddPayload(context)).not.toHaveProperty("sourceConversation");
      expect(resolveCronDeliveryPreview).toHaveBeenCalledWith(
        expect.objectContaining({ job: expect.objectContaining({ sourceConversation }) }),
      );
      expectCronSuccess(respond);
    },
  );

  it("attributes an agent-created job to the admitted requester, not the session creator", async () => {
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: "agent:ops:main",
      entry: {
        sessionId: "session-ops-main",
        createdVia: "spawn",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      },
    });
    const client = callerClient("ops");
    client.internal!.operatorRunAuthority = createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    const { context, respond } = await invokeCron("cron.add", agentTurnCronParams(), { client });
    expect(
      requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options").createdActor,
    ).toEqual({ type: "human", source: "profile", id: "profile-ada" });
    expectCronSuccess(respond);
  });

  it.each([undefined, "missing-conversation"])(
    "leaves isolated jobs unbound without an existing creating session: %s",
    async (sessionKey) => {
      const { context, respond } = await invokeCron(
        "cron.add",
        agentTurnCronParams({ sessionKey }),
      );
      const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
      expect(options).not.toHaveProperty("sourceConversation");
      expectCronSuccess(respond);
    },
  );

  it.each(["deleted", "reset"] as const)(
    "refuses isolated creation when the supplied conversation is %s before commit",
    async (change) => {
      const sessionKey = "agent:main:conversation";
      loadGatewaySessionEntry.mockReturnValue({
        canonicalKey: sessionKey,
        entry: { sessionId: "creating-session", lifecycleRevision: "generation-1" },
      });
      resolveCronDeliveryPreview.mockImplementationOnce(async () => {
        loadGatewaySessionEntry.mockReturnValue({
          canonicalKey: sessionKey,
          entry:
            change === "reset"
              ? { sessionId: "creating-session", lifecycleRevision: "generation-2" }
              : undefined,
        });
        return { label: "conversation", detail: "conversation" };
      });
      const context = createCronContext();
      await expect(
        invokeCron("cron.add", agentTurnCronParams({ sessionKey }), { context }),
      ).rejects.toThrow("Creator session changed before scheduling");
      expect(context.committedAdds).toEqual([]);
    },
  );

  it.each(["unknown"] as const)(
    "retains %s creator provenance through agent-created cron jobs",
    async (source) => {
      loadGatewaySessionEntry.mockReturnValue({
        canonicalKey: "agent:ops:main",
        entry: {
          sessionId: "session-ops-main",
          createdVia: "spawn",
          createdActor: { type: "human", source, id: "profile-ada", label: "Ada" },
        },
      });
      const client = callerClient("ops");
      client.internal!.agentRuntimeIdentity!.sessionSpawnContext = {
        inheritedToolPolicy: { version: 1, allow: ["*"], deny: [] },
      };

      const { context, respond } = await invokeCron("cron.add", agentTurnCronParams(), {
        client,
      });

      const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
      expect(options.createdActor).toEqual({
        type: "human",
        source,
        id: "profile-ada",
        label: "Ada",
      });
      expect(loadGatewaySessionEntry).toHaveBeenCalledWith("agent:ops:main", { agentId: "ops" });
      expect(requireCronAddPayload(context)).not.toHaveProperty("createdActor");
      expectCronSuccess(respond);
    },
  );

  it.each([
    { createdActor: { type: "human", source: "profile", id: "spoofed-profile" } },
    { sourceConversation: { sessionKey: "agent:main:other", sessionId: "spoofed-session" } },
  ])("rejects caller-supplied private cron creator facts: %j", async (privateFields) => {
    const { context, respond } = await invokeCron("cron.add", agentTurnCronParams(privateFields));

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST" });
  });
}
