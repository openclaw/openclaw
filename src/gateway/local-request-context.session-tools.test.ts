// Exercises built-in session tools through the real in-process router and SQLite store.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsCreateResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import * as modelRuntimeChoice from "../agents/model-runtime-choice.js";
import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayTool,
  type InProcessGatewayCaller,
  type AgentToolGatewayRequestCaller,
  runWithGatewayToolCleanupContext,
} from "../agents/tools/in-process-gateway.js";
import { createSessionsListTool } from "../agents/tools/sessions-list-tool.js";
import { maybeSpawnVisibleSession } from "../agents/tools/sessions-spawn-visible.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { registerChatAbortController } from "./chat-abort.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
} from "./device-revocation.js";
import { registerSessionToolParticipantTests } from "./local-request-context.session-tools.participants.test-support.js";
import {
  REQUESTER,
  TARGET,
  TARGET_ID,
  INCOGNITO,
  withSessionToolsFixture,
  seedSessionToolsFixtureSession,
  drainSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import {
  runWithOperatorToolGatewayCleanupContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { roleClient } from "./session-sharing.test-utils.js";

// This authority fixture creates no browser tabs; lifecycle cleanup and tab
// ownership have dedicated coverage without cold-loading Browser's source graph here.
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

const mainSession = (sessionKey: string) => loadSessionEntry({ agentId: "main", sessionKey });
const localContext = () => expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "Gateway");
const toolOptions = (config: OpenClawConfig) => ({ config, agentSessionKey: REQUESTER });
const sessionKeys = () =>
  listSessionEntriesCore({ agentId: "main" }).map((entry) => entry.sessionKey);
function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: args }],
  };
}
function spawnVisible(
  params: Pick<Parameters<typeof maybeSpawnVisibleSession>[0], "options"> &
    Partial<Parameters<typeof maybeSpawnVisibleSession>[0]>,
) {
  return maybeSpawnVisibleSession({
    raw: { visible: true },
    task: "inspect",
    label: "",
    runtime: "subagent",
    sandbox: "inherit",
    expectsCompletionMessage: false,
    ...params,
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

  afterEach(drainSessionToolsFixture);

  registerSessionToolParticipantTests();

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
        const context = localContext();
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
          toolCall("read-fixture", "read"),
          {
            role: "toolResult",
            toolCallId: "read-fixture",
            toolName: "read",
            content: [{ type: "text", text: "fixture contents" }],
          },
          toolCall("spawn-child", "sessions_spawn", { context: "fork", visible: true }),
        ];
        for (const message of messages) {
          await appendTranscriptMessage(scope, {
            message,
            cwd: cfg.agents?.entries?.main?.workspace,
          });
        }
        const admission = await beginSessionEffect({
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
        const beforeKeys = sessionKeys();
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
                spawnVisible({
                  raw: { visible: true, context: "fork", model: "openai/gpt-5.6-luna" },
                  task: "Continue from the inherited reproduction",
                  label: "Forked work",
                  options: { ...toolOptions(cfg), registerRun, countActiveRuns: () => 0 },
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
            expect(sessionKeys()).toEqual(beforeKeys);
            return;
          }
          const result = await spawn();
          expect(result).toMatchObject({ status: "accepted" });
          const childKey = result?.childSessionKey;
          if (typeof childKey !== "string") {
            throw new Error("expected created child session key");
          }
          const child = expectDefined(mainSession(childKey), "persisted child session");
          expect(child.parentSessionId).toBe(sessionId);
          const transcript = await loadTranscriptEvents({
            agentId: "main",
            sessionKey: childKey,
            sessionId: child.sessionId,
          });
          const inherited = messages.map((message) =>
            expect.objectContaining({ type: "message", message: expect.objectContaining(message) }),
          );
          expect(transcript).toEqual(expect.arrayContaining(inherited));
          expect(startChild).toHaveBeenCalledOnce();
          const childMessage = startChild.mock.calls[0]?.[0].params.message;
          expect(childMessage).toContain("inherited conversation is background context");
          expect(childMessage).toContain("Continue from the inherited reproduction");
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
    (generation) =>
      withSessionToolsFixture(async (cfg) => {
        const context = localContext();
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
          successor = mainSession(childKey);
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
              target: captureSessionTarget({
                storeScope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
                sessionKey: childKey,
                incarnation: successor.sessionId,
                agentId: "main",
              }),
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
            () => spawnVisible({ options: { ...toolOptions(cfg), callGateway } }),
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
          expect(mainSession(childKey)).toEqual(
            generation === "unchanged" || generation === "active" ? undefined : successor,
          );
        } finally {
          registeredRun?.cleanup();
        }
      }),
  );

  it("retains inherited system ownership through deferred cleanup under a scoped operator", () =>
    withSessionToolsFixture(async () => {
      const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "local Gateway scope");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: TARGET },
        { visibility: "draft" },
      );
      const owner = ensureGatewayOwnerProfile("Owner");
      const restricted = roleClient("none");
      const profile = expectDefined(restricted.authenticatedUserProfile, "operator profile");
      restricted.internal = {
        operatorRoleActor: { kind: "operator", profileId: profile.profileId },
      };
      const released = createDeferredCore();
      const patch = (label: string) =>
        callAgentToolGatewayRequest({
          method: "sessions.patch",
          params: { key: TARGET, expectedSessionId: TARGET_ID, label },
        });
      const handoff = await withPluginRuntimeGatewayRequestScope(
        { ...scope, client: restricted },
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
      expect(mainSession(TARGET)?.label).toBe("Foreground owner");
      released.resolve();
      await handoff.pending;
      expect(mainSession(TARGET)?.label).toBe("Detached owner");
    }));

  it.each(["system", "operator", "closed request", "revoked device"] as const)(
    "settles self-archive with live source authority after caller closure (%s)",
    (caller) =>
      withSessionToolsFixture(async (cfg) => {
        const context = localContext();
        const client = roleClient("write");
        const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
        const { sessionKey, sessionId } = await seedSessionToolsFixtureSession({
          sessionKey: "agent:main:dashboard:session-tools-self-archive",
          sessionId: "session-tools-self-archive-id",
          creatorId: caller === "system" ? "other-person" : profile.profileId,
        });
        const archived = createDeferredCore();
        context.subscribeSessionEvents("self-archive-proof");
        context.broadcastToConnIds = (event, payload) => {
          if (event === "sessions.changed") {
            expect(payload).toMatchObject({ sessionKey });
            archived.resolve();
          }
        };
        const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
        const admission = await beginSessionEffect({
          scope: storePath,
          identities: [sessionKey, sessionId],
          assertAllowed: () => {},
        });
        let current = true;
        const settled = createDeferredCore();
        const sourceReleased = createDeferredCore();
        const source = captureGatewayDeviceRevocation(
          context,
          { deviceId: "archive-device", role: "operator" },
          () => current,
          undefined,
          { isCurrent: () => true, subscribe: () => () => sourceReleased.resolve() },
        );
        try {
          const archive = () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey,
                operationalRunInstance: { instanceId: "archive-instance", runId: "archive-run" },
                receiptAuthority: () => current,
                gatewayContextResolver: () => context,
              },
              () =>
                admission.run(() =>
                  createSessionsTool({
                    config: cfg,
                    agentSessionKey: sessionKey,
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
          const invoke = () =>
            caller !== "system"
              ? withOperatorToolGatewayAuthority(
                  { authenticatedUserProfile: profile, scopes: client.connect.scopes ?? [] },
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
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
          expect(mainSession(sessionKey)?.archivedAt).toBeUndefined();
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
          expect(mainSession(sessionKey)?.archivedAt).toBeUndefined();
          return;
        }
        await settled.promise;
        await archived.promise;
        await sourceReleased.promise;
        expect(readGatewayDeviceSourceAuthority(source.isCurrent)?.()).toBe(false);
        expect(mainSession(sessionKey)).toMatchObject({
          sessionId,
          archivedAt: expect.any(Number),
        });
      }),
  );

  it.each(["sessions.patch", "sessions.patchMany", "sessions.assignOwner"])(
    "%s does not commit when its caller closes during request authorization",
    (method) =>
      withSessionToolsFixture(async (cfg) => {
        const context = localContext();
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
          const entry = mainSession(TARGET);
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
      }),
  );

  it.each(["all", "self"] as const)(
    "enforces %s session visibility for discovery and archive under system-backed dispatch",
    (visibility) =>
      withSessionToolsFixture(async (cfg) => {
        const options = {
          config: visibility === "all" ? cfg : { ...cfg, tools: { sessions: { visibility } } },
          agentSessionKey: REQUESTER,
        };
        const listed = await createSessionsListTool(options).execute(
          visibility === "all" ? "discover" : "discover-self",
          {},
        );
        const archive = () =>
          createSessionsTool(options).execute(visibility === "all" ? "archive" : "denied-foreign", {
            action: "patch",
            sessionKey: TARGET,
            expectedSessionId: TARGET_ID,
            archived: true,
          });
        if (visibility === "self") {
          expect(listed.details).toMatchObject({
            count: 1,
            sessions: [expect.objectContaining({ key: REQUESTER })],
          });
          await expect(archive()).rejects.toThrow(/visibility|restricted|not visible/i);
          await expect(
            createSessionsTool(toolOptions(cfg)).execute("denied-incognito", {
              action: "patch",
              sessionKey: INCOGNITO,
              pinned: true,
            }),
          ).rejects.toThrow(/not visible/i);
          expect(mainSession(TARGET)?.archivedAt).toBeUndefined();
          return;
        }
        // Keep archive in the same reproduction even if discovery regresses to an empty result.
        expect.soft(listed.details).toMatchObject({
          count: 3,
          sessions: expect.arrayContaining([
            expect.objectContaining({ key: REQUESTER }),
            expect.objectContaining({ key: TARGET, sessionId: TARGET_ID }),
            expect.objectContaining({ key: "agent:other:dashboard:session-tools-other" }),
          ]),
        });
        await expect(archive()).resolves.toMatchObject({
          details: { status: "updated", sessionKey: TARGET },
        });
        expect(mainSession(TARGET)).toMatchObject({
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
      }),
  );

  it("does not grant system authority to an unknown synthetic caller or override a scoped reader", () =>
    withSessionToolsFixture(async (cfg) => {
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

      const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "local Gateway scope");
      const reader = roleClient("view", "reader-profile");
      reader.connect.scopes = ["operator.read"];
      await withPluginRuntimeGatewayRequestScope({ ...scope, client: reader }, async () => {
        await expect(
          createSessionsTool(toolOptions(cfg)).execute("denied-reader", {
            action: "patch",
            sessionKey: TARGET,
            expectedSessionId: TARGET_ID,
            archived: true,
          }),
        ).rejects.toThrow(/missing scope: operator.write/i);
      });
      expect(mainSession(TARGET)?.archivedAt).toBeUndefined();
    }));
});
