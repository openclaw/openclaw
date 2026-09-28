// Exercises built-in session tools through the real in-process router and SQLite store.
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsCreateResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import * as modelRuntimeChoice from "../agents/model-runtime-choice.js";
import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayTool,
  type InProcessGatewayCaller,
  type AgentToolGatewayRequestCaller,
  runWithGatewayToolCleanupContext,
} from "../agents/tools/in-process-gateway.js";
import { createSessionStatusTool } from "../agents/tools/session-status-tool.js";
import { createSessionsHistoryTool } from "../agents/tools/sessions-history-tool.js";
import { createSessionsListTool } from "../agents/tools/sessions-list-tool.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { maybeSpawnVisibleSession } from "../agents/tools/sessions-spawn-visible.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
} from "./device-revocation.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import {
  runWithOperatorToolGatewayCleanupContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

// This authority fixture creates no browser tabs; lifecycle cleanup and tab
// ownership have dedicated coverage without cold-loading Browser's source graph here.
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

const REQUESTER = "agent:main:dashboard:session-tools-requester";
const TARGET = "agent:main:dashboard:session-tools-target";
const TARGET_ID = "session-tools-target-id";
const INCOGNITO = "agent:main:dashboard:incognito-session-tools";
const PARTICIPANT_SHARED = "agent:main:dashboard:participant-shared";
const PARTICIPANT_DRAFT = "agent:main:dashboard:participant-draft";
const PARTICIPANT_DRAFT_ID = "participant-draft-id";
let fixtureRun: Promise<void> | undefined;

function withSessionToolsFixture(run: (cfg: OpenClawConfig) => Promise<void>) {
  return (fixtureRun = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: state.workspaceDir },
          other: { workspace: state.path("other-workspace") },
        },
      },
      tools: { sessions: { visibility: "all" } },
    };
    await state.writeConfig(cfg);
    for (const [agentId, sessionKey, sessionId] of [
      ["main", REQUESTER, "session-tools-requester-id"],
      ["main", TARGET, TARGET_ID],
      ["main", INCOGNITO, "session-tools-incognito-id"],
      ["other", "agent:other:dashboard:session-tools-other", "session-tools-other-id"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        {
          sessionId,
          updatedAt: 1,
          visibility: "shared",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "other-person" },
        },
      );
    }
    const resources = new LegacyPluginSdkResourceHost();
    try {
      await resources.run(() =>
        withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, () =>
          run(cfg),
        ),
      );
    } finally {
      await resources.close();
    }
  }));
}

function withParticipantSessionToolsFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    turn: Parameters<Parameters<typeof withPersonalToolTurn>[1]>[0];
    alice: Parameters<typeof withPersonalToolTurn>[0]["owner"];
    bob: Parameters<typeof withPersonalToolTurn>[0]["owner"];
  }) => Promise<void>,
) {
  return withSessionToolsFixture(async (cfg) => {
    const person = (name: string) => {
      const client = roleClient("write", `${name.toLowerCase()}-participant`);
      const profileId = client.authenticatedUserProfile?.profileId;
      if (!profileId) {
        throw new Error("expected participant profile");
      }
      return {
        profileId,
        senderId: `${name.toLowerCase()}-sender`,
        name,
        readCurrentRoleAssignment: () => "write",
      };
    };
    const alice = person("Alice");
    const bob = person("Bob");
    for (const [sessionKey, sessionId, visibility, marker] of [
      [PARTICIPANT_DRAFT, PARTICIPANT_DRAFT_ID, "draft", "Alice's distinctive draft marker"],
      [PARTICIPANT_SHARED, "participant-shared-id", "shared", "Shared participant marker"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          visibility,
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: alice.profileId },
        },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId },
        { message: { role: "user", content: marker } },
      );
    }
    await withPersonalToolTurn(
      { owner: alice, sessionKey: REQUESTER, sessionId: "session-tools-requester-id" },
      (turn) => run({ cfg, turn, alice, bob }),
    );
  });
}

describe("built-in session tool role authority", () => {
  let runtimeSetup: Promise<unknown>[] = [];
  beforeAll(() => {
    // Load real read and mutation handlers before their request deadlines begin.
    runtimeSetup = [
      import("./server-methods/chat.js"),
      import("./server-methods/sessions-create.js"),
      import("./server-methods/sessions-delete.js"),
      import("./server-methods/sessions-mutations.js"),
      import("./server-methods/sessions-read.js"),
      import("./server-methods/sessions.runtime.js"),
    ];
    return Promise.all(runtimeSetup);
  });
  afterAll(async () => {
    // A failed import does not cancel its siblings; drain their module setup too.
    await Promise.allSettled(runtimeSetup);
  });

  afterEach(async () => {
    // Vitest timeouts do not cancel the callback. Join its state cleanup before
    // global resets or the next fixture can replace this process's environment.
    await fixtureRun?.catch(() => {});
    fixtureRun = undefined;
  });

  it("uses the named participant's current identity for session reads and writes", async () => {
    await withParticipantSessionToolsFixture(async ({ cfg, turn, alice, bob }) => {
      const options = { config: cfg, agentSessionKey: REQUESTER };
      const history = createSessionsHistoryTool(options);
      const read = (sessionKey: string, user?: string) =>
        history.execute("participant-history", { sessionKey, user });
      const expectDraft = async (user?: string) =>
        expect((await read(PARTICIPANT_DRAFT, user)).details).toMatchObject({
          messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
        });

      await expectDraft();
      expect(await turn.steer(bob)).toMatchObject({ status: "accepted" });
      await expect(read(PARTICIPANT_DRAFT)).rejects.toThrow(
        `Several people have steered this turn: Alice (user: ${alice.profileId}), Bob (user: ${bob.profileId}). Pass the requester's requester_profile.id as user, or ask them if unclear.`,
      );
      expect((await read(PARTICIPANT_DRAFT, bob.profileId)).details).toMatchObject({
        status: "error",
        error: expect.stringMatching(/not found|no session found/i),
      });
      expect((await read(PARTICIPANT_SHARED, bob.profileId)).details).toMatchObject({
        messages: [expect.objectContaining({ content: "Shared participant marker" })],
      });
      await expectDraft(alice.profileId);
      await expect(read(PARTICIPANT_DRAFT, "unknown-profile")).rejects.toThrow(/not a participant/);

      const sessionStatus = createSessionStatusTool(options);
      await expect(
        sessionStatus.execute("draft-status", {
          sessionKey: PARTICIPANT_DRAFT,
          user: bob.profileId,
        }),
      ).rejects.toThrow(/not found|not visible/i);
      const notify = (sessionKey: string) =>
        createSessionsSendTool(options).execute("participant-notify", {
          sessionKey,
          message: "Bob's selected notification",
          mode: "notify",
          user: bob.profileId,
        });
      expect((await notify(PARTICIPANT_DRAFT)).details).toMatchObject({
        status: "error",
        error: expect.stringMatching(/not found|no session found/i),
      });
      expect(drainSystemEvents(PARTICIPANT_DRAFT)).toEqual([]);
      await expect(notify(PARTICIPANT_SHARED)).resolves.toMatchObject({
        details: { status: "queued", sessionKey: PARTICIPANT_SHARED, runStarted: false },
      });
      expect(drainSystemEvents(PARTICIPANT_SHARED)).toEqual([
        expect.stringContaining("Bob's selected notification"),
      ]);

      const patch = (user: string) =>
        createSessionsTool(options).execute("participant-patch", {
          action: "patch",
          sessionKey: PARTICIPANT_DRAFT,
          expectedSessionId: PARTICIPANT_DRAFT_ID,
          label: "Selected participant write",
          user,
        });
      await expect(patch(bob.profileId)).rejects.toThrow("session is draft for this connection");
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: PARTICIPANT_DRAFT })?.label,
      ).toBeUndefined();
      await expect(patch(alice.profileId)).resolves.toMatchObject({
        details: { status: "updated", sessionKey: PARTICIPANT_DRAFT },
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: PARTICIPANT_DRAFT })?.label).toBe(
        "Selected participant write",
      );

      turn.revoke(bob.profileId);
      await expect(read(PARTICIPANT_SHARED, bob.profileId)).rejects.toThrow(/Bob's access changed/);
      await expectDraft(alice.profileId);
      turn.complete();
      await expect(read(PARTICIPANT_DRAFT, alice.profileId)).rejects.toThrow(/turn has ended/);
    });
  });

  it("rejects an unnamed history read when another participant steers during the read", async () => {
    await withParticipantSessionToolsFixture(async ({ cfg, turn, alice, bob }) => {
      const context = getPluginRuntimeGatewayRequestScope()?.context;
      if (!context) {
        throw new Error("expected local Gateway context");
      }
      // This hook runs after the real history handler has authorized the draft
      // and read its transcript. The final publication must recheck selection.
      context.readChatStartupProjection = vi
        .fn(async () => undefined)
        .mockImplementationOnce(async () => {
          expect(await turn.steer(bob)).toMatchObject({ status: "accepted" });
          return undefined;
        });
      const history = createSessionsHistoryTool({
        config: cfg,
        agentSessionKey: REQUESTER,
      });
      await expect(
        history.execute("racing-history", { sessionKey: PARTICIPANT_DRAFT }),
      ).rejects.toThrow(
        `Several people have steered this turn: Alice (user: ${alice.profileId}), Bob (user: ${bob.profileId}). Pass the requester's requester_profile.id as user, or ask them if unclear.`,
      );
      expect(context.readChatStartupProjection).toHaveBeenCalledOnce();
      expect(
        (
          await history.execute("selected-history", {
            sessionKey: PARTICIPANT_DRAFT,
            user: alice.profileId,
          })
        ).details,
      ).toMatchObject({
        messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
      });
    });
  });

  it("rejects identity-only session reads after another participant steers", async () => {
    await withParticipantSessionToolsFixture(async ({ turn, alice, bob }) => {
      const context = getPluginRuntimeGatewayRequestScope()?.context;
      const operatorRunAuthority = getGatewayToolCallerIdentity()?.operatorAuthority;
      if (!context || !operatorRunAuthority) {
        throw new Error("expected local Gateway context and admitted operator");
      }
      const client = sharingPolicyClient({ user: alice.profileId });
      client.connect.client.id = "gateway-client";
      client.internal = {
        syntheticClient: true,
        agentRuntimeIdentity: turn.runtimeIdentity,
        operatorRunAuthority,
        operatorRoleActor: { kind: "operator", profileId: alice.profileId },
      };
      const read = () =>
        withoutGatewayToolCallerIdentity(() =>
          dispatchGatewayRequestInProcessRaw(
            "chat.history",
            { sessionKey: PARTICIPANT_DRAFT, agentId: "main" },
            { context, client },
          ),
        );
      await expect(read()).resolves.toMatchObject({
        ok: true,
        payload: {
          messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
        },
      });
      expect(await turn.steer(bob)).toMatchObject({ status: "accepted" });
      await expect(read()).rejects.toThrow(
        `Several people have steered this turn: Alice (user: ${alice.profileId}), Bob (user: ${bob.profileId}). Pass the requester's requester_profile.id as user, or ask them if unclear.`,
      );
    });
  });

  it.each(["live", "missing", "retired"] as const)(
    "visible forks preserve an active first turn only with live requester authority (%s)",
    async (lifetime) => {
      const runtimeChoice = vi
        .spyOn(modelRuntimeChoice, "preparePublishedModelRuntimeChoice")
        .mockImplementation(async ({ runtimeId, preferredRuntimeId }) => ({
          kind: "ready",
          runtimeId: runtimeId ?? preferredRuntimeId ?? "codex",
          validate: () => undefined,
        }));
      onTestFinished(() => runtimeChoice.mockRestore());
      await withSessionToolsFixture(async (cfg) => {
        const context = getPluginRuntimeGatewayRequestScope()?.context;
        if (!context) {
          throw new Error("expected local Gateway context");
        }
        let current = true;
        context.loadGatewayModelCatalogSnapshot = async () => {
          if (lifetime === "retired") {
            current = false;
          }
          const entries = [
            { id: "gpt-5.6-luna", name: "Test model", provider: "openai", contextWindow: 200_000 },
          ];
          return {
            entries,
            routeVariants: entries,
            agentId: "main",
            agentDir: resolveAgentDir(cfg, "main"),
            workspaceDir: resolveAgentWorkspaceDir(cfg, "main"),
            config: cfg,
            catalogComplete: true,
          };
        };
        const sessionId = "session-tools-requester-id";
        const scope = { agentId: "main", sessionKey: REQUESTER, sessionId };
        const messages = [
          {
            role: "user",
            content: "Reproduce the attached fixture",
            __openclaw: { media: [{ url: "media://inbound/repro.txt", fileName: "repro.txt" }] },
          },
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "read-fixture", name: "read", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "read-fixture",
            toolName: "read",
            content: [{ type: "text", text: "fixture contents" }],
          },
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "spawn-child",
                name: "sessions_spawn",
                arguments: { context: "fork", visible: true },
              },
            ],
          },
        ];
        for (const message of messages) {
          await appendTranscriptMessage(scope, {
            message,
            cwd: cfg.agents?.entries?.main?.workspace,
          });
        }
        const admission = await beginSessionWorkAdmission({
          scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
          identities: [REQUESTER, sessionId],
          assertAllowed: () => {},
        });
        const chatSendOwner = await import("./server-methods/chat-send-external-entry.js");
        const startChild = vi
          .spyOn(chatSendOwner, "handleDirectExternalChatSend")
          .mockImplementation(async ({ respond }) => {
            respond(true, { status: "started", runId: "fork-child-run" });
          });
        const registerRun = vi.fn();
        const beforeKeys = listSessionEntriesCore({ agentId: "main" }).map(
          (entry) => entry.sessionKey,
        );
        try {
          const spawn = () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: REQUESTER,
                gatewayContextResolver: () => context,
                ...(lifetime !== "missing"
                  ? {
                      operationalRunInstance: {
                        instanceId: "fork-instance",
                        runId: "fork-parent-run",
                      },
                      receiptAuthority: () => current,
                    }
                  : {}),
              },
              () =>
                maybeSpawnVisibleSession({
                  raw: { visible: true, context: "fork", model: "openai/gpt-5.6-luna" },
                  task: "Continue from the inherited reproduction",
                  label: "Forked work",
                  runtime: "subagent",
                  sandbox: "inherit",
                  expectsCompletionMessage: false,
                  options: {
                    config: cfg,
                    agentSessionKey: REQUESTER,
                    registerRun,
                    countActiveRuns: () => 0,
                  },
                }),
            );
          if (lifetime !== "live") {
            await expect(spawn()).rejects.toThrow(
              lifetime === "missing"
                ? /Parent session .* is still active/
                : /authority is no longer active/,
            );
            expect(startChild).not.toHaveBeenCalled();
            expect(registerRun).not.toHaveBeenCalled();
            expect(
              listSessionEntriesCore({ agentId: "main" }).map((entry) => entry.sessionKey),
            ).toEqual(beforeKeys);
            return;
          }
          const result = await spawn();
          expect(result).toMatchObject({ status: "accepted" });
          const childKey = result?.childSessionKey;
          if (typeof childKey !== "string") {
            throw new Error("expected created child session key");
          }
          const child = loadSessionEntry({ agentId: "main", sessionKey: childKey });
          if (!child) {
            throw new Error("expected persisted child session");
          }
          expect(child.parentSessionId).toBe(sessionId);
          const transcript = await loadTranscriptEvents({
            agentId: "main",
            sessionKey: childKey,
            sessionId: child.sessionId,
          });
          expect(transcript).toEqual(
            expect.arrayContaining(
              messages.map((message) =>
                expect.objectContaining({
                  type: "message",
                  message: expect.objectContaining(message),
                }),
              ),
            ),
          );
          expect(startChild).toHaveBeenCalledOnce();
          const childMessage = startChild.mock.calls[0]?.[0].params.message;
          expect(childMessage).toContain("inherited conversation is background context");
          expect(childMessage).toContain(
            "[Subagent Task]\n\nContinue from the inherited reproduction",
          );
          expect(registerRun).toHaveBeenCalledOnce();
          expect(loadSessionEntry(scope)?.sessionId).toBe(sessionId);
        } finally {
          startChild.mockRestore();
          admission.release();
        }
      });
    },
  );

  it.each(["unchanged", "active", "replaced", "reset"] as const)(
    "visible-spawn rollback protects the admitted child generation (%s)",
    async (generation) => {
      await withSessionToolsFixture(async (cfg) => {
        const context = getPluginRuntimeGatewayRequestScope()?.context;
        if (!context) {
          throw new Error("expected local Gateway context");
        }
        let current = true;
        let childKey: string | undefined;
        let successor: ReturnType<typeof loadSessionEntry>;
        let registeredRun: ReturnType<typeof registerChatAbortController> | undefined;
        // Use the production spawn transport for every fixture mutation. A request
        // deadline can reject while setup is still mutating this fixture's state.
        const callGateway: InProcessGatewayCaller = async <T>(
          method: string,
          params: Record<string, unknown>,
        ): Promise<T> => {
          if (method !== "sessions.create") {
            return await runWithGatewayToolCleanupContext(
              () => callInProcessGatewayTool<T>(method, params),
              () => context,
            );
          }
          // Keep real creation with default model selection and its response identity.
          // Initial task dispatch and explicit-model catalog preparation are outside rollback.
          const { task: _task, model: _model, ...creation } = params;
          const created = await callInProcessGatewayTool<SessionsCreateResult>(method, creation);
          if (!created.sessionId) {
            throw new Error("session creation did not return its incarnation");
          }
          childKey = created.key;
          if (generation === "replaced") {
            await callInProcessGatewayTool("sessions.delete", { key: childKey });
            await callInProcessGatewayTool("sessions.create", { agentId: "main", key: childKey });
          } else if (generation === "reset") {
            await callInProcessGatewayTool("sessions.reset", { key: childKey });
          }
          successor = loadSessionEntry({ agentId: "main", sessionKey: childKey });
          if (!successor) {
            throw new Error("expected persisted child before rollback");
          }
          if (generation === "replaced") {
            expect(successor.sessionId).not.toBe(created.sessionId);
          } else if (generation === "reset") {
            expect(successor.sessionId).toBe(created.sessionId);
            expect(successor.lifecycleRevision).not.toBe(created.entry?.lifecycleRevision);
          }
          if (generation === "reset" || generation === "active") {
            registeredRun = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId: `${generation}-run`,
              sessionId: successor.sessionId,
              sessionKey: childKey,
              agentId: "main",
              timeoutMs: 60_000,
            });
            const run = registeredRun;
            run.controller.signal.addEventListener("abort", () => run.cleanup(), { once: true });
          }
          current = false;
          return { ...created, runStarted: generation === "reset" || generation === "active" } as T;
        };
        try {
          const result = await withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: REQUESTER,
              operationalRunInstance: { instanceId: "spawn-instance", runId: "spawn-run" },
              receiptAuthority: () => current,
              gatewayContextResolver: () => context,
            },
            () =>
              maybeSpawnVisibleSession({
                raw: { visible: true },
                task: "inspect",
                label: "",
                runtime: "subagent",
                sandbox: "inherit",
                expectsCompletionMessage: false,
                options: { config: cfg, agentSessionKey: REQUESTER, callGateway },
              }),
          );
          expect(result).toMatchObject({
            status: "error",
            error: expect.stringContaining(
              generation === "unchanged" || generation === "active"
                ? "Session removed."
                : "Session changed; newer session kept.",
            ),
          });
          if (!childKey) {
            throw new Error("expected a created child");
          }
          if (registeredRun) {
            expect.soft(registeredRun.controller.signal.aborted).toBe(generation === "active");
          }
          expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toEqual(
            generation === "unchanged" || generation === "active" ? undefined : successor,
          );
        } finally {
          registeredRun?.cleanup();
        }
      });
    },
  );

  it.each([false, true])(
    "retains inherited system ownership through deferred cleanup (scoped operator: %s)",
    async (scopedOperator) => {
      await withSessionToolsFixture(async () => {
        const scope = getPluginRuntimeGatewayRequestScope();
        if (!scope) {
          throw new Error("expected local Gateway scope");
        }
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: TARGET },
          { visibility: "draft" },
        );
        const owner = ensureGatewayOwnerProfile("Owner");
        const restricted = roleClient("none");
        if (!restricted.authenticatedUserProfile) {
          throw new Error("expected operator profile");
        }
        restricted.internal = {
          operatorRoleActor: {
            kind: "operator",
            profileId: restricted.authenticatedUserProfile.profileId,
          },
        };
        const released = createDeferredCore();
        const patch = (label: string) =>
          callAgentToolGatewayRequest({
            method: "sessions.patch",
            params: { key: TARGET, expectedSessionId: TARGET_ID, label },
          });
        const handoff = await withPluginRuntimeGatewayRequestScope(
          { ...scope, ...(scopedOperator ? { client: restricted } : {}) },
          () =>
            withOperatorToolGatewayAuthority(
              {
                authenticatedUserProfile: {
                  profileId: owner.id,
                  displayName: owner.displayName,
                  hasAvatar: false,
                  updatedAt: owner.updatedAt,
                },
                operatorRoleActor: { kind: "system" },
                scopes: ["operator.write"],
              },
              async () => {
                await patch("Foreground owner");
                return {
                  pending: runWithOperatorToolGatewayCleanupContext(() =>
                    released.promise.then(() => patch("Detached owner")),
                  ),
                };
              },
            ),
        );
        expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.label).toBe(
          "Foreground owner",
        );
        released.resolve();
        await handoff.pending;
        expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.label).toBe(
          "Detached owner",
        );
      });
    },
  );

  it.each(["system", "operator", "closed request", "revoked device"] as const)(
    "settles self-archive with live source authority after caller closure (%s)",
    async (caller) => {
      await withSessionToolsFixture(async (cfg) => {
        const context = getPluginRuntimeGatewayRequestScope()?.context;
        if (!context) {
          throw new Error("expected local Gateway context");
        }
        const archived = createDeferredCore();
        context.subscribeSessionEvents("self-archive-proof");
        context.broadcastToConnIds = (event, payload) => {
          if (event === "sessions.changed") {
            expect(payload).toMatchObject({ sessionKey: REQUESTER });
            archived.resolve();
          }
        };
        const sessionId = "session-tools-requester-id";
        const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
        const admission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [REQUESTER, sessionId],
          assertAllowed: () => {},
        });
        let current = true;
        const settled = createDeferredCore();
        const client = roleClient("write");
        const source = captureGatewayDeviceRevocation(
          context,
          { deviceId: "archive-device", role: "operator" },
          () => current,
          undefined,
          { isCurrent: () => true, subscribe: () => () => {} },
        );
        try {
          const archive = () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: REQUESTER,
                operationalRunInstance: { instanceId: "archive-instance", runId: "archive-run" },
                receiptAuthority: () => current,
                gatewayContextResolver: () => context,
              },
              () =>
                admission.run(() =>
                  createSessionsTool({
                    config: cfg,
                    agentSessionKey: REQUESTER,
                    agentSessionId: sessionId,
                    callGateway: async <T>(
                      request: Parameters<AgentToolGatewayRequestCaller>[0],
                    ) => {
                      try {
                        const result = await callAgentToolGatewayRequest<T>(request);
                        settled.resolve();
                        return result;
                      } catch (error) {
                        settled.reject(error);
                        throw error;
                      }
                    },
                  }).execute("archive-self", { action: "patch", archived: true }),
                ),
            );
          if (!client.authenticatedUserProfile) {
            throw new Error("expected operator profile");
          }
          const invoke = () =>
            caller !== "system"
              ? withOperatorToolGatewayAuthority(
                  {
                    authenticatedUserProfile: client.authenticatedUserProfile,
                    scopes: client.connect.scopes ?? [],
                  },
                  archive,
                )
              : archive();
          const result = await (caller === "closed request" || caller === "revoked device"
            ? withPluginRuntimeGatewayRequestScope(
                {
                  ...getPluginRuntimeGatewayRequestScope(),
                  context,
                  client,
                  isWebchatConnect: () => false,
                  hasCurrentClientAuthority: source.isCurrent,
                },
                invoke,
              )
            : invoke());
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey: REQUESTER });
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: REQUESTER })?.archivedAt,
          ).toBeUndefined();
          if (caller === "revoked device") {
            invalidateGatewayDeviceRevocation(context, "archive-device", "operator");
          }
        } finally {
          current = false;
          source.release();
          admission.release();
        }
        if (caller === "revoked device") {
          await expect(settled.promise).rejects.toThrow(/authority.*no longer active/);
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: REQUESTER })?.archivedAt,
          ).toBeUndefined();
          return;
        }
        await settled.promise;
        await archived.promise;
        expect(readGatewayDeviceSourceAuthority(source.isCurrent)?.()).toBe(false);
        expect(loadSessionEntry({ agentId: "main", sessionKey: REQUESTER })).toMatchObject({
          sessionId,
          archivedAt: expect.any(Number),
        });
      });
    },
  );

  it.each(["sessions.patch", "sessions.patchMany", "sessions.assignOwner"])(
    "%s does not commit when its caller closes during request authorization",
    async (method) => {
      await withSessionToolsFixture(async (cfg) => {
        const context = getPluginRuntimeGatewayRequestScope()?.context;
        if (!context) {
          throw new Error("expected local Gateway context");
        }
        const patchParams = (label: string) =>
          method === "sessions.patch"
            ? { key: TARGET, label }
            : method === "sessions.patchMany"
              ? { targets: [{ key: TARGET }], patch: { label } }
              : { key: TARGET, owner: { type: "agent", id: label } };
        const before = method === "sessions.assignOwner" ? "main" : "Before closure";
        const after = method === "sessions.assignOwner" ? "other" : "After closure";
        const request = (value: string) =>
          callAgentToolGatewayRequest({
            method,
            params: patchParams(value),
            agentToolCaller: { agentId: "main", sessionKey: REQUESTER },
          });
        const persisted = () => {
          const entry = loadSessionEntry({ agentId: "main", sessionKey: TARGET });
          return method === "sessions.assignOwner" ? entry?.owner?.actor.id : entry?.label;
        };
        await request(before);
        expect(persisted()).toBe(before);
        let current = true;
        // Authorization reads the live config after dispatch has yielded. Close
        // the run there and verify the real SQLite writer still refuses the patch.
        context.getRuntimeConfig = () => {
          current = false;
          return cfg;
        };
        await expect(
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: REQUESTER,
              operationalRunInstance: { instanceId: "patch-instance", runId: "patch-run" },
              receiptAuthority: () => current,
            },
            () => request(after),
          ),
        ).rejects.toThrow(/authority.*no longer active/i);
        expect(persisted()).toBe(before);
      });
    },
  );

  it("lists then archives a visible session through built-in tools with roles enabled", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const options = { config: cfg, agentSessionKey: REQUESTER };
      const listed = await createSessionsListTool(options).execute("discover", {});
      // Keep archive in the same reproduction even if discovery regresses to an empty result.
      expect.soft(listed.details).toMatchObject({
        count: 3,
        sessions: expect.arrayContaining([
          expect.objectContaining({ key: REQUESTER }),
          expect.objectContaining({ key: TARGET, sessionId: TARGET_ID }),
          expect.objectContaining({ key: "agent:other:dashboard:session-tools-other" }),
        ]),
      });
      await expect(
        createSessionsTool(options).execute("archive", {
          action: "patch",
          sessionKey: TARGET,
          expectedSessionId: TARGET_ID,
          archived: true,
        }),
      ).resolves.toMatchObject({ details: { status: "updated", sessionKey: TARGET } });
      expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })).toMatchObject({
        sessionId: TARGET_ID,
        archivedAt: expect.any(Number),
      });
      const archived = await createSessionsListTool(options).execute("verify", {
        archived: true,
      });
      expect(archived.details).toMatchObject({
        count: 1,
        sessions: [expect.objectContaining({ key: TARGET, archived: true })],
      });
    });
  });

  it("keeps tool visibility and incognito boundaries under system-backed dispatch", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const options = {
        config: { ...cfg, tools: { sessions: { visibility: "self" as const } } },
        agentSessionKey: REQUESTER,
      };
      const listed = await createSessionsListTool(options).execute("discover-self", {});
      expect(listed.details).toMatchObject({
        count: 1,
        sessions: [expect.objectContaining({ key: REQUESTER })],
      });
      await expect(
        createSessionsTool(options).execute("denied-foreign", {
          action: "patch",
          sessionKey: TARGET,
          expectedSessionId: TARGET_ID,
          archived: true,
        }),
      ).rejects.toThrow(/visibility|restricted|not visible/i);
      await expect(
        createSessionsTool({ config: cfg, agentSessionKey: REQUESTER }).execute(
          "denied-incognito",
          { action: "patch", sessionKey: INCOGNITO, pinned: true },
        ),
      ).rejects.toThrow(/not visible/i);
      expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt).toBeUndefined();
    });
  });

  it("does not grant system authority to an unknown synthetic caller or override a scoped reader", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const unknown = await dispatchGatewayMethodInProcess<{ sessions: unknown[] }>(
        "sessions.list",
        { agentId: "main" },
        { forceSyntheticClient: true, syntheticScopes: ["operator.read"] },
      );
      expect(unknown.sessions).toEqual([]);
      await expect(
        dispatchGatewayMethodInProcess(
          "sessions.patch",
          { key: TARGET, expectedSessionId: TARGET_ID, archived: true },
          { forceSyntheticClient: true, syntheticScopes: ["operator.write"] },
        ),
      ).rejects.toThrow(/not found/i);
      await expect(
        callAgentToolGatewayRequest({
          method: "sessions.patch",
          params: { key: TARGET, expectedSessionId: TARGET_ID, archived: true },
          scopes: ["operator.read"],
        }),
      ).rejects.toThrow(/missing scope: operator.write/i);

      const scope = getPluginRuntimeGatewayRequestScope();
      if (!scope) {
        throw new Error("expected local Gateway scope");
      }
      const reader = roleClient("view", "reader-profile");
      reader.connect.scopes = ["operator.read"];
      await withPluginRuntimeGatewayRequestScope(
        {
          ...scope,
          client: reader,
        },
        async () => {
          await expect(
            createSessionsTool({ config: cfg, agentSessionKey: REQUESTER }).execute(
              "denied-reader",
              {
                action: "patch",
                sessionKey: TARGET,
                expectedSessionId: TARGET_ID,
                archived: true,
              },
            ),
          ).rejects.toThrow(/missing scope: operator.write/i);
        },
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt).toBeUndefined();
    });
  });
});
