import { expect, it, vi, type Mock } from "vitest";
import {
  bindCronManagementGrant,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import type { CronDeliveryPreview } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createCronCreatorAuthorityRunScope } from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  agentTurnCronParams,
  createCronCallerClient as callerClient,
  type createCronTestInvoker,
  expectCronSuccess,
  expectCronReply,
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
  const { makeStorePath } = createCronStoreHarness({ prefix: "cron-payload-provenance-" });
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
  it.each(["systemEvent", "agentTurn"] as const)(
    "cleans up persisted %s payloads explicitly edited from another conversation",
    async (kind) => {
      // Load after the validation suite installs its session-reader fixtures.
      const { cronHandlers } = await import("./cron.js");
      const { storePath } = await makeStorePath();
      const scheduler = createTestGatewayScheduler();
      const cron = new CronService({
        scheduler,
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
      });
      const first = { sessionKey: "agent:main:first", sessionId: "first-session" };
      const second = { sessionKey: "agent:main:second", sessionId: "second-session" };
      const payload = (text: string) =>
        kind === "systemEvent" ? ({ kind, text } as const) : ({ kind, message: text } as const);
      const context = createDirectChatContext({ cron, cronStorePath: storePath, getRuntimeConfig });
      const client = callerClient("main", undefined, second.sessionKey);
      const identity = client.internal!.agentRuntimeIdentity!;
      const authority = claimAgentRunDelegatedAuthority(identity.operationalRunInstance);
      identity.delegatedAuthority = { kind: "local", ...authority };
      loadGatewaySessionEntry.mockImplementation((sessionKey: string) => ({
        canonicalKey: sessionKey,
        entry: { sessionId: sessionKey === second.sessionKey ? second.sessionId : first.sessionId },
      }));
      try {
        const input = {
          name: "Synthetic reminder",
          enabled: true,
          schedule: { kind: "every" as const, everyMs: 60_000 },
          sessionTarget: kind === "systemEvent" ? ("main" as const) : ("isolated" as const),
          wakeMode: "next-heartbeat" as const,
          payload: payload("Original context"),
          owner: { agentId: "main", sessionKey: first.sessionKey },
        };
        const created = await cron.add(input, {
          ownerSessionId: first.sessionId,
          payloadSourceConversation: first,
          ...(kind === "agentTurn" ? { sourceConversation: first } : {}),
        });
        const unrelated = await cron.add({ ...input, name: "Unrelated reminder" });
        const update = async (patch: Record<string, unknown>) => {
          const scope = createCronCreatorAuthorityRunScope(
            identity.operationalRunInstance.runId,
            { kind: "local" },
            { source: "control-ui-admin" },
          );
          const params = { id: created.id, patch };
          const respond = vi.fn();
          await runWithCronCreatorAuthorityCapability(scope, () =>
            withGatewayToolCallerIdentity(
              { ...identity, approvalAuthority: authority },
              async () => {
                identity.cronManagementGrant = bindCronManagementGrant(scope.runId)!.mint(
                  "cron.update",
                );
                await cronHandlers["cron.update"]!({
                  req: { type: "req", id: "edit-reminder", method: "cron.update", params },
                  params,
                  respond,
                  context,
                  client,
                  isWebchatConnect: () => false,
                });
              },
            ),
          );
          expectCronReply(respond, expect.objectContaining({ id: created.id }), "once");
        };
        await update({ name: "Renamed reminder" });
        await update({ payload: payload("Original context") });
        expect(await cron.readJob(created.id)).toMatchObject({ payloadSourceConversation: first });
        await update({ payload: payload("Updated context from second conversation") });
        const persisted = (await loadCronStore(storePath)).jobs;
        expect(persisted.every((job) => job.enabled)).toBe(true);
        expect(persisted.find((job) => job.id === created.id)).toMatchObject({
          owner: input.owner,
          ownerSessionId: first.sessionId,
          payloadSourceConversation: second,
          ...(kind === "agentTurn" ? { sourceConversation: first } : {}),
        });
        const cleanup = await disableCronJobsBoundToSessions({
          cron,
          cfg: {},
          sessions: [{ ...second, agentId: "main" }],
        });
        expect(cleanup.failures).toEqual([]);
        expect(cleanup.disabledBySession.get(second.sessionKey)).toEqual([created.id]);
        expect(
          (await loadCronStore(storePath)).jobs.map(({ id, enabled }) => ({ id, enabled })),
        ).toEqual([
          { id: created.id, enabled: false },
          { id: unrelated.id, enabled: true },
        ]);
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
        cron.stop();
        await scheduler.stop();
      }
    },
  );

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
