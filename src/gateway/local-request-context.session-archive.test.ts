// Proves discovery -> caller-bound RPC -> deferred archive without a model or live Gateway.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import {
  setActiveEmbeddedRun,
  clearActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../agents/embedded-agent-runner/runs.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { assignSessionOwner } from "../config/sessions/session-accessor.sqlite-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// These fixtures create no browser resources; keep unrelated browser loading out of archive proof.
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

const TARGET = "agent:main:dashboard:assigned-archive";
const TARGET_ID = "assigned-archive-id";
let fixtureRun: Promise<void> | undefined;
afterEach(async () => {
  await fixtureRun?.catch(() => {});
  fixtureRun = undefined;
});

function withSessionToolsFixture(run: (cfg: OpenClawConfig) => Promise<void>) {
  return (fixtureRun = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      tools: { sessions: { visibility: "all" } },
    };
    await state.writeConfig(cfg);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: TARGET },
      {
        sessionId: TARGET_ID,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "other-person" },
      },
    );
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

describe("scoped session archive tools", () => {
  beforeAll(async () => {
    // Keep the first Stop call's cold handler import outside its RPC deadline.
    await import("./server-methods/sessions-abort.js");
  });

  it("keeps archive but withholds Stop from embedded and admitted MCP collectors", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const request = getPluginRuntimeGatewayRequestScope();
      if (!request?.context) {
        throw new Error("expected local Gateway context");
      }
      const client = roleClient("write");
      const runId = "collector-session-controls";
      addSubagentRunForTests({ runId, childSessionKey: TARGET, collect: true });
      try {
        await withPluginRuntimeGatewayRequestScope({ ...request, client }, () =>
          withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: client.authenticatedUserProfile,
              scopes: ["operator.write"],
            },
            async () => {
              const options = {
                config: cfg,
                agentId: "main",
                sessionKey: TARGET,
                sessionId: TARGET_ID,
                runId,
                senderIsOwner: false,
              };
              for (const tools of [
                createOpenClawCodingTools({ ...options, swarmCollector: true }),
                resolveGatewayScopedTools({ ...options, cfg, surface: "loopback" }).tools,
              ]) {
                const tool = expectDefined(
                  tools.find((candidate) => candidate.name === "sessions"),
                  "collector archive tool",
                );
                expect(tool.parameters).toMatchObject({
                  properties: {
                    action: { enum: ["patch", "assign_owner"] },
                    archived: { type: "boolean" },
                  },
                });
                expect(tool.parameters).not.toHaveProperty("properties.runId");
                await expect(
                  tool.execute("collector-stop", { action: "stop", sessionKey: TARGET }),
                ).rejects.toThrow(/unavailable to non-interactive collectors/);
                expect(tools.some((candidate) => candidate.name === "sessions_send")).toBe(false);
              }
            },
          ),
        );
      } finally {
        resetSubagentRegistryForTests({ persist: false });
      }
    });
  });

  it.each(["unbound", "reader", "session-writer"] as const)(
    "does not expose archive to a %s caller",
    async (caller) => {
      await withSessionToolsFixture(async (cfg) => {
        const options = {
          config: cfg,
          agentId: "main",
          sessionKey: TARGET,
          sessionId: TARGET_ID,
          senderIsOwner: false,
        };
        const check = async () => {
          const assignment = expectDefined(
            createOpenClawCodingTools(options).find((tool) => tool.name === "sessions"),
            "assignment-only tool",
          );
          expect(assignment.parameters).toMatchObject({
            properties: { action: { enum: ["assign_owner"] } },
          });
          expect(assignment.parameters).not.toHaveProperty("properties.archived");
          await expect(
            assignment.execute("no-archive", { action: "patch", archived: true }),
          ).rejects.toThrow(/Only assign_owner/);
          expect(
            resolveGatewayScopedTools({ ...options, cfg, surface: "loopback" }).tools.some(
              (tool) => tool.name === "sessions",
            ),
          ).toBe(false);
        };
        if (caller === "unbound") {
          await check();
        } else {
          const client = roleClient("view");
          const scope = caller === "session-writer" ? "operator.sessions.write" : "operator.read";
          client.connect.scopes = [scope];
          await withPluginRuntimeGatewayRequestScope(
            { ...getPluginRuntimeGatewayRequestScope(), client, isWebchatConnect: () => false },
            () =>
              withOperatorToolGatewayAuthority(
                {
                  authenticatedUserProfile: client.authenticatedUserProfile,
                  scopes: [scope],
                },
                check,
              ),
          );
        }
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt,
        ).toBeUndefined();
      });
    },
  );

  it.each(["unassigned archive", "ordinary stop"] as const)(
    "enforces the requested ordinary-session contract: %s",
    async (scenario) => {
      await withSessionToolsFixture(async (cfg) => {
        const client = roleClient("write");
        const request = getPluginRuntimeGatewayRequestScope();
        if (!request) {
          throw new Error("expected local Gateway scope");
        }
        await withPluginRuntimeGatewayRequestScope({ ...request, client }, () =>
          withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: client.authenticatedUserProfile,
              scopes: ["operator.write"],
            },
            async () => {
              const tool = expectDefined(
                createOpenClawCodingTools({
                  config: cfg,
                  agentId: "main",
                  sessionKey: TARGET,
                  sessionId: TARGET_ID,
                  senderIsOwner: false,
                }).find((candidate) => candidate.name === "sessions"),
                "session control tool",
              );
              if (scenario === "ordinary stop") {
                expect(tool.parameters).toMatchObject({
                  properties: { action: { enum: expect.arrayContaining(["stop"]) } },
                });
                return;
              }
              await expect(
                tool.execute("foreign-archive", {
                  action: "patch",
                  sessionKey: TARGET,
                  expectedSessionId: TARGET_ID,
                  archived: true,
                }),
              ).rejects.toThrow(/session creator/i);
            },
          ),
        );
      });
    },
  );

  it.each(["creator", "assignee", "unrelated", "replacement"] as const)(
    "stops only the authorized ordinary-session run (%s)",
    async (relationship) => {
      await withSessionToolsFixture(async (cfg) => {
        const request = getPluginRuntimeGatewayRequestScope();
        if (!request?.context) {
          throw new Error("expected local Gateway context");
        }
        const client = roleClient("write");
        const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
        const requesterKey = "agent:main:dashboard:stop-requester";
        const targetKey =
          relationship === "creator" ? "agent:main:dashboard:created-stop-target" : TARGET;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: requesterKey },
          {
            sessionId: "stop-requester-id",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profile.profileId },
          },
        );
        if (relationship === "creator") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: targetKey },
            {
              sessionId: TARGET_ID,
              updatedAt: 1,
              createdActor: { type: "human", source: "profile", id: profile.profileId },
            },
          );
        } else if (relationship !== "unrelated") {
          assignSessionOwner(
            { agentId: "main", sessionKey: TARGET },
            {
              owner: { type: "human", id: profile.profileId },
              assignedBy: { type: "human", id: profile.profileId },
            },
          );
        }
        const run = registerChatAbortController({
          chatAbortControllers: request.context.chatAbortControllers,
          runId: "ordinary-stop-run",
          sessionKey: targetKey,
          sessionId: TARGET_ID,
          agentId: "main",
          timeoutMs: 60_000,
        });
        run.controller.signal.addEventListener("abort", () => run.cleanup(), { once: true });
        try {
          await withPluginRuntimeGatewayRequestScope({ ...request, client }, () =>
            withOperatorToolGatewayAuthority(
              { authenticatedUserProfile: profile, scopes: ["operator.write"] },
              async () => {
                const tool = expectDefined(
                  createOpenClawCodingTools({
                    config: cfg,
                    agentId: "main",
                    sessionKey: requesterKey,
                    sessionId: "stop-requester-id",
                    senderIsOwner: false,
                  }).find((candidate) => candidate.name === "sessions"),
                  "session controls",
                );
                const stop = withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey: requesterKey,
                    operationalRunInstance: {
                      instanceId: "stop-tool-instance",
                      runId: "stop-tool-run",
                    },
                    receiptAuthority: () => true,
                    gatewayContextResolver: () => request.context,
                  },
                  () =>
                    tool.execute("stop-ordinary", {
                      action: "stop",
                      sessionKey: targetKey,
                      runId: "ordinary-stop-run",
                      expectedSessionId:
                        relationship === "replacement" ? "old-session-id" : TARGET_ID,
                    }),
                );
                if (relationship === "unrelated" || relationship === "replacement") {
                  await expect(stop).rejects.toThrow(/creator|assigned|changed/i);
                } else {
                  const result = await stop;
                  expect(result.details).toMatchObject({ ok: true });
                }
              },
            ),
          );
          expect(run.controller.signal.aborted).toBe(
            relationship === "creator" || relationship === "assignee",
          );
        } finally {
          run.cleanup();
        }
      });
    },
  );

  it.each(["assigned", "unrelated"] as const)(
    "preserves non-owner active-run steering under session-send access (%s)",
    async (scenario) => {
      await withSessionToolsFixture(async (cfg) => {
        const request = getPluginRuntimeGatewayRequestScope();
        if (!request?.context) {
          throw new Error("expected local Gateway context");
        }
        const client = roleClient("write");
        const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
        const requesterKey = "agent:main:dashboard:steer-requester";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: requesterKey },
          {
            sessionId: "steer-requester-id",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profile.profileId },
          },
        );
        if (scenario === "assigned") {
          assignSessionOwner(
            { agentId: "main", sessionKey: TARGET },
            {
              owner: { type: "human", id: profile.profileId },
              assignedBy: { type: "human", id: profile.profileId },
            },
          );
        }
        const accepted = vi.fn();
        const legacyQueue = vi.fn(async () => {
          throw new Error("unexpected legacy queue path");
        });
        const handle: EmbeddedAgentQueueHandle = {
          runId: "ordinary-steer-run",
          queueMessage: legacyQueue,
          isStreaming: () => true,
          isCompacting: () => false,
          supportsTranscriptCommitWait: true,
          sourceReplyDeliveryMode: "automatic",
          abort: () => {},
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: async (_text, _options, assertCurrent) => {
              assertCurrent();
              accepted();
            },
          },
        };
        setActiveEmbeddedRun(TARGET_ID, handle, TARGET, undefined, "main");
        try {
          await withPluginRuntimeGatewayRequestScope({ ...request, client }, () =>
            withOperatorToolGatewayAuthority(
              { authenticatedUserProfile: profile, scopes: ["operator.write"] },
              async () => {
                const tool = expectDefined(
                  createOpenClawCodingTools({
                    config: cfg,
                    agentId: "main",
                    sessionKey: requesterKey,
                    sessionId: "steer-requester-id",
                    senderIsOwner: false,
                  }).find((candidate) => candidate.name === "sessions_send"),
                  "session steering",
                );
                const result = await tool.execute("steer-ordinary", {
                  mode: "steer",
                  sessionKey: TARGET,
                  message: "Use the updated requirements",
                  timeoutSeconds: 0,
                });
                expect(result.details, JSON.stringify(result.details)).toMatchObject({
                  status: "accepted",
                  targetDisposition: "steered",
                });
              },
            ),
          );
          expect(accepted).toHaveBeenCalledOnce();
          expect(legacyQueue).not.toHaveBeenCalled();
        } finally {
          clearActiveEmbeddedRun(TARGET_ID, handle);
        }
      });
    },
  );

  it("allows creator self-archive and denies assignee archive or restore through the assembled tool surface", async () => {
    const scope = "operator.write";
    await withSessionToolsFixture(async (cfg) => {
      const request = getPluginRuntimeGatewayRequestScope();
      if (!request?.context) {
        throw new Error("expected local Gateway context");
      }
      const client = roleClient("write");
      client.connect.scopes = [scope];
      const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
      const sessionKey = "agent:main:dashboard:operator-archive";
      const sessionId = "operator-archive-id";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: profile.profileId },
        },
      );
      assignSessionOwner(
        { agentId: "main", sessionKey: TARGET },
        {
          owner: { type: "human", id: profile.profileId },
          assignedBy: { type: "human", id: profile.profileId },
        },
      );
      const archived = createDeferredCore();
      request.context.subscribeSessionEvents("operator-archive-proof");
      request.context.broadcastToConnIds = (event, payload) => {
        if (
          event === "sessions.changed" &&
          isRecord(payload) &&
          payload.sessionKey === sessionKey
        ) {
          archived.resolve();
        }
      };
      const admission = await beginSessionWorkAdmission({
        scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
      let retained: ReturnType<typeof createOpenClawCodingTools>[number] | undefined;
      try {
        const result = await withPluginRuntimeGatewayRequestScope({ ...request, client }, () =>
          withOperatorToolGatewayAuthority(
            { authenticatedUserProfile: profile, scopes: [scope] },
            async () => {
              const options = {
                config: cfg,
                agentId: "main",
                sessionKey,
                sessionId,
                senderIsOwner: false,
              };
              const tools = createOpenClawCodingTools(options);
              const gatewayTools = resolveGatewayScopedTools({
                ...options,
                cfg,
                surface: "loopback",
              }).tools;
              for (const surface of [tools, gatewayTools]) {
                const tool = expectDefined(
                  surface.find((candidate) => candidate.name === "sessions"),
                  "session writer archive tool",
                );
                expect(tool.parameters).toMatchObject({
                  properties: {
                    action: { enum: ["patch", "stop", "assign_owner"] },
                    archived: { type: "boolean" },
                  },
                  required: ["action"],
                });
                await expect(
                  tool.execute("not-archive", { action: "reset", sessionKey: TARGET }),
                ).rejects.toThrow(/archive|restore/i);
                await expect(
                  tool.execute("not-settings", {
                    action: "patch",
                    archived: true,
                    model: "other",
                  }),
                ).rejects.toThrow(/archive|restore/i);
              }
              const tool = expectDefined(
                tools.find((candidate) => candidate.name === "sessions"),
                "archive tool",
              );
              retained = tool;
              const archiveAssigned = (value: boolean) =>
                tool.execute("archive-assigned", {
                  action: "patch",
                  sessionKey: TARGET,
                  expectedSessionId: TARGET_ID,
                  archived: value,
                });
              await expect(archiveAssigned(true)).rejects.toThrow(/session creator/i);
              expect(
                loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt,
              ).toBeUndefined();
              const archivedAt = 123;
              await upsertSessionEntryCore({ agentId: "main", sessionKey: TARGET }, { archivedAt });
              await expect(archiveAssigned(false)).rejects.toThrow(/session creator/i);
              expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt).toBe(
                archivedAt,
              );
              return await admission.run(() =>
                tool.execute("archive-own-session", { action: "patch", archived: true }),
              );
            },
          ),
        );
        expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.archivedAt).toBeUndefined();
      } finally {
        admission.release();
      }
      await archived.promise;
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        sessionId,
        archivedAt: expect.any(Number),
      });
      await expect(
        expectDefined(retained, "retained archive tool").execute("expired-restore", {
          action: "patch",
          archived: false,
        }),
      ).rejects.toThrow(/current operator write grant/);
    });
  });
});
