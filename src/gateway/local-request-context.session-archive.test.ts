// Proves discovery -> caller-bound RPC -> deferred archive without a model or live Gateway.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { CliDeps } from "../cli/deps.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { assignSessionOwner } from "../config/sessions/session-accessor.sqlite-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { seedSessionToolsEntry } from "./local-request-context.session-tools.test-support.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// These fixtures create no browser resources; keep unrelated browser loading out of archive proof.
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

const TARGET = "agent:main:dashboard:assigned-archive";
const TARGET_ID = "assigned-archive-id";
const session = (sessionKey: string) => ({ agentId: "main", sessionKey });
const entry = (sessionKey: string) => loadSessionEntry(session(sessionKey));
const findTool = (tools: ReturnType<typeof createOpenClawCodingTools>, name = "sessions") =>
  expectDefined(
    tools.find((tool) => tool.name === name),
    `${name} tool`,
  );
const assign = (profileId: string) =>
  assignSessionOwner(session(TARGET), {
    owner: { type: "human", id: profileId },
    assignedBy: { type: "human", id: profileId },
  });
const requestScope = () => {
  const request = expectDefined(getPluginRuntimeGatewayRequestScope(), "local Gateway scope");
  return { ...request, context: expectDefined(request.context, "local Gateway context") };
};
const toolOptions = (config: OpenClawConfig, sessionKey: string, sessionId: string) => ({
  config,
  agentId: "main",
  sessionKey,
  sessionId,
  senderIsOwner: false,
});
const withOperator = <T>(client: ReturnType<typeof roleClient>, run: () => Promise<T>) =>
  withPluginRuntimeGatewayRequestScope({ ...requestScope(), client }, () =>
    withOperatorToolGatewayAuthority(
      { authenticatedUserProfile: client.authenticatedUserProfile, scopes: ["operator.write"] },
      run,
    ),
  );
const seed = (sessionKey: string, sessionId: string, id: string) =>
  seedSessionToolsEntry(sessionKey, sessionId, {
    createdActor: { type: "human", source: "profile", id },
  });
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
    setRuntimeConfigSnapshot(cfg);
    await seedSessionToolsEntry(TARGET, TARGET_ID, {
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: "other-person" },
    });
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

  it("withholds Stop from embedded and admitted MCP collectors", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const client = roleClient("write");
      const runId = "collector-session-controls";
      seedSubagentRunForReadTest({ runId, childSessionKey: TARGET, collect: true });
      try {
        await withOperator(client, async () => {
          const options = {
            ...toolOptions(cfg, TARGET, TARGET_ID),
            runId,
          };
          for (const tools of [
            createOpenClawCodingTools({ ...options, swarmCollector: true }),
            (await resolveGatewayScopedTools({ ...options, cfg, surface: "loopback" })).tools,
          ]) {
            const tool = findTool(tools);
            await expect(
              tool.execute("collector-stop", { action: "stop", sessionKey: TARGET }),
            ).rejects.toThrow(/unavailable to non-interactive collectors/);
            expect(tools.some((candidate) => candidate.name === "sessions_send")).toBe(false);
          }
        });
      } finally {
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  });

  it.each(["unbound", "reader", "session-writer"] as const)(
    "does not expose archive to a %s caller",
    async (caller) => {
      await withSessionToolsFixture(async (cfg) => {
        const options = toolOptions(cfg, TARGET, TARGET_ID);
        const check = async () => {
          await expect(
            findTool(createOpenClawCodingTools(options)).execute("no-archive", {
              action: "patch",
              archived: true,
            }),
          ).rejects.toThrow(
            caller === "session-writer" ? /current operator write grant/ : /Only assign_owner/,
          );
          expect(
            (await resolveGatewayScopedTools({ ...options, cfg, surface: "loopback" })).tools.some(
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
      });
    },
  );

  it.each(["creator", "assignee", "unrelated", "replacement"] as const)(
    "stops only the authorized ordinary-session run (%s)",
    async (relationship) => {
      await withSessionToolsFixture(async (cfg) => {
        const request = requestScope();
        const client = roleClient("write");
        const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
        const requesterKey = "agent:main:dashboard:stop-requester";
        const targetKey =
          relationship === "creator" ? "agent:main:dashboard:created-stop-target" : TARGET;
        await seed(requesterKey, "stop-requester-id", profile.profileId);
        if (relationship === "creator") {
          await seed(targetKey, TARGET_ID, profile.profileId);
        } else if (relationship !== "unrelated") {
          assign(profile.profileId);
        }
        const run = registerChatAbortController({
          target: captureSessionTarget({
            storeScope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
            sessionKey: targetKey,
            incarnation: TARGET_ID,
            agentId: "main",
          }),
          runId: "ordinary-stop-run",
          sessionKey: targetKey,
          sessionId: TARGET_ID,
          agentId: "main",
          timeoutMs: 60_000,
        });
        run.controller.signal.addEventListener("abort", () => run.cleanup(), { once: true });
        try {
          await withOperator(client, async () => {
            const tool = findTool(
              createOpenClawCodingTools(toolOptions(cfg, requesterKey, "stop-requester-id")),
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
                  expectedSessionId: relationship === "replacement" ? "old-session-id" : TARGET_ID,
                }),
            );
            if (relationship === "unrelated" || relationship === "replacement") {
              await expect(stop).rejects.toThrow(/creator|assigned|changed/i);
            } else {
              const result = await stop;
              expect(result.details).toMatchObject({ ok: true });
            }
          });
          expect(run.controller.signal.aborted).toBe(
            relationship === "creator" || relationship === "assignee",
          );
        } finally {
          run.cleanup();
        }
      });
    },
  );

  it("allows creator self-archive and denies assignee archive or restore through the assembled tool surface", async () => {
    const scope = "operator.write";
    await withSessionToolsFixture(async (cfg) => {
      const request = requestScope();
      const client = roleClient("write");
      client.connect.scopes = [scope];
      const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
      const sessionKey = "agent:main:dashboard:operator-archive";
      const sessionId = "operator-archive-id";
      await seed(sessionKey, sessionId, profile.profileId);
      assign(profile.profileId);
      const archived = createDeferredCore();
      const context = request.context;
      context.subscribeSessionEvents("operator-archive-proof");
      context.broadcastToConnIds = (event, payload) => {
        if (
          event === "sessions.changed" &&
          isRecord(payload) &&
          payload.sessionKey === sessionKey
        ) {
          archived.resolve();
        }
      };
      const admission = await beginSessionEffect({
        scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
      let retained: ReturnType<typeof createOpenClawCodingTools>[number] | undefined;
      try {
        const result = await withOperator(client, async () => {
          const options = toolOptions(cfg, sessionKey, sessionId);
          const tools = createOpenClawCodingTools(options);
          const gatewayTools = (
            await resolveGatewayScopedTools({
              ...options,
              cfg,
              surface: "loopback",
            })
          ).tools;
          const tool = findTool(tools);
          for (const surface of [tools, gatewayTools]) {
            await expect(
              findTool(surface).execute("not-settings", {
                action: "patch",
                archived: true,
                model: "other",
              }),
            ).rejects.toThrow(/archive|restore/i);
          }
          retained = tool;
          const archiveAssigned = (value: boolean) =>
            findTool(value ? gatewayTools : tools).execute("archive-assigned", {
              action: "patch",
              sessionKey: TARGET,
              expectedSessionId: TARGET_ID,
              archived: value,
            });
          await expect(archiveAssigned(true)).rejects.toThrow(/session creator/i);
          expect(entry(TARGET)?.archivedAt).toBeUndefined();
          const archivedAt = 123;
          await upsertSessionEntryCore({ agentId: "main", sessionKey: TARGET }, { archivedAt });
          await expect(archiveAssigned(false)).rejects.toThrow(/session creator/i);
          expect(entry(TARGET)?.archivedAt).toBe(archivedAt);
          return await admission.run(() =>
            tool.execute("archive-own-session", { action: "patch", archived: true }),
          );
        });
        expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        expect(entry(sessionKey)?.archivedAt).toBeUndefined();
      } finally {
        admission.release();
      }
      await archived.promise;
      expect(entry(sessionKey)).toMatchObject({
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
