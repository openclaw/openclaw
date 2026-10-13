import { expect, it, type Mock } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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

export function registerCronCreatorSessionTests(
  getRuntimeConfig: Mock<() => OpenClawConfig>,
  fixture: {
    invokeCron: ReturnType<typeof createCronTestInvoker>;
    loadGatewaySessionEntry: Mock<(sessionKey: string) => CronCreatorSessionLookup>;
    resolveCronDeliveryPreview: Mock<() => Promise<CronDeliveryPreview>>;
  },
) {
  const { invokeCron, loadGatewaySessionEntry, resolveCronDeliveryPreview } = fixture;
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

    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: "agent:main:foreign",
      entry: {
        sessionId: "foreign",
        createdActor: { type: "human", source: "profile", id: "foreign-person" },
      },
    });
    const { context, respond } = await invokeCron(
      "cron.add",
      agentTurnCronParams({ sessionKey: "agent:main:foreign" }),
      { client },
    );

    const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
    expect(options.createdActor).toEqual({ type: "human", source: "profile", id: "profile-ada" });
    expect(options.sandboxProvenance).toEqual({
      actor: { type: "human", source: "profile", id: "profile-ada" },
    });
    expect(requireCronAddPayload(context)).not.toHaveProperty("createdActor");
    expectCronSuccess(respond);
  });

  it.each([
    {
      caller: "agent-runtime",
      payload: { kind: "agentTurn", message: "report", toolsAllow: ["*"] },
    },
    { caller: "operator", payload: { kind: "agentTurn", message: "report", toolsAllow: ["*"] } },
    {
      caller: "agent-runtime",
      payload: { kind: "script", script: "return { notify: 'report' };", toolsAllow: [] },
    },
    {
      caller: "operator",
      payload: { kind: "script", script: "return { notify: 'report' };", toolsAllow: [] },
    },
    { caller: "operator", payload: { kind: "command", argv: ["echo", "report"] } },
  ])(
    "captures the fallback conversation for isolated $caller $payload.kind jobs",
    async ({ caller, payload }) => {
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
        agentTurnCronParams({ agentId: "ops", sessionKey: "conversation", payload }),
        caller === "agent-runtime"
          ? { client: callerClient("ops", undefined, sourceConversation.sessionKey) }
          : undefined,
      );

      const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
      expect(options.sourceConversation).toEqual(sourceConversation);
      if (caller === "operator") {
        expect(options).not.toHaveProperty("skillLibrarySelections");
        expect(options).not.toHaveProperty("createdActor");
        expect(options.sandboxProvenance).toEqual({ actor: undefined });
      } else {
        expect(options.skillLibrarySelections).toEqual([]);
        expect(options.createdActor).toEqual({
          type: "human",
          source: "profile",
          id: "profile-ada",
        });
        expect(options.sandboxProvenance).toEqual({
          actor: { type: "human", source: "profile", id: "profile-ada" },
        });
      }
      expect(requireCronAddPayload(context)).not.toHaveProperty("sourceConversation");
      expect(resolveCronDeliveryPreview).toHaveBeenCalledWith(
        expect.objectContaining({ job: expect.objectContaining({ sourceConversation }) }),
      );
      expectCronSuccess(respond);
    },
  );

  it.each([undefined, false, true])(
    "selects the agent-created job creator with Lab=%s",
    async (enabled) => {
      getRuntimeConfig.mockReturnValue({
        agents: { defaults: { experimental: { delegatedCreatorAttribution: enabled } } },
      });
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
      ).toEqual({
        type: "human",
        source: "profile",
        id: enabled ? "profile-ada" : "another-profile",
      });
      expectCronSuccess(respond);
    },
  );

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
    { sandboxProvenance: { actor: { type: "human", source: "profile", id: "spoofed-profile" } } },
    { sandbox: "required" },
    { sourceConversation: { sessionKey: "agent:main:other", sessionId: "spoofed-session" } },
  ])("rejects caller-supplied private cron creator facts: %j", async (privateFields) => {
    const { context, respond } = await invokeCron("cron.add", agentTurnCronParams(privateFields));

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST" });
    const update = await invokeCron("cron.update", { id: "existing-job", patch: privateFields });
    expect(update.context.cron.update).not.toHaveBeenCalled();
    expectResponseError(update.respond, { code: "INVALID_REQUEST" });
  });
}
