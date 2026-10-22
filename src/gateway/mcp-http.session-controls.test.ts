import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as inProcessGateway from "../agents/tools/in-process-gateway.js";
import type { CliDeps } from "../cli/deps.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "../config/sessions/session-accessor.sqlite-owner.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { readOperatorToolGatewayAuthority } from "./operator-tool-gateway-authority.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

const requesterKey = "agent:main:dashboard:mcp-archive-requester";
const targetKey = "agent:main:dashboard:mcp-archive-target";
const targetId = "mcp-archive-target-id";
const target = { agentId: "main", sessionKey: targetKey };
const sessionEntry = (sessionId: string, creator: string, updatedAt = 1) => ({
  sessionId,
  updatedAt,
  visibility: "shared" as const,
  createdActor: { type: "human" as const, source: "profile" as const, id: creator },
});

it.each(["allowed", "assigned-noncreator", "reassigned", "profile-revoked", "replaced"] as const)(
  "MCP HTTP preserves archive final-effect authority: %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        tools: { sessions: { visibility: "all" } },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const client = roleClient("write");
      const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requesterKey },
        sessionEntry("mcp-archive-requester-id", profile.profileId),
      );
      await upsertSessionEntryCore(
        target,
        sessionEntry(
          targetId,
          scenario === "assigned-noncreator" ? "other-person" : profile.profileId,
        ),
      );
      const assignOwner = (id: string) =>
        assignSessionOwner(target, {
          owner: { type: "human", id },
          assignedBy: { type: "human", id: profile.profileId },
        });
      assignOwner(profile.profileId);
      const archive = async () => {
        const operatorAuthority = expectDefined(
          readOperatorToolGatewayAuthority()?.operatorRunAuthority,
          "host-issued operator source",
        );
        const runId = "mcp-final-effect-HTTP-" + scenario;
        const admission = mcp.prepareAdmission(runId, "mcp-final-effect-test", {
          cfg,
          operatorAuthority,
        });
        const releaseWriter = createDeferredCore();
        const atWriter = createDeferredCore();
        let pending: Promise<unknown> | undefined;
        let grantToken: string | undefined;
        const realCall = inProcessGateway.callAgentToolGatewayRequest;
        const requestSpy = vi
          .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
          .mockImplementation(async (request) => {
            if (request.method === "sessions.patch") {
              atWriter.resolve();
              await releaseWriter.promise;
            }
            return await realCall(request);
          });
        try {
          const admittedRunContext = await admission.admit("gateway", "mcp-final-effect-runtime");
          const runtime = mcp.runtime();
          const grant = mcp.captureGrant(
            {
              runtimeOwnerToken: runtime.ownerToken,
              admittedRunContext,
              context: {
                sessionKey: requesterKey,
                sessionId: "mcp-archive-requester-id",
                agentId: "main",
                runId,
                senderIsOwner: false,
                toolsAllow: ["sessions"],
              },
            },
            runId + "-capture",
            (token) => {
              grantToken = token;
            },
          );
          pending = mcp
            .request(
              runtime,
              mcp.toolCall("sessions", {
                action: "patch",
                sessionKey: targetKey,
                expectedSessionId: targetId,
                archived: true,
              }),
              grant,
            )
            .then(mcp.json);
          const reachedWriter = await Promise.race([
            atWriter.promise.then(() => true),
            pending.then(() => false),
          ]);
          expect(reachedWriter).toBe(scenario !== "assigned-noncreator");
          if (scenario === "reassigned") {
            assignOwner("different-person");
          } else if (scenario === "profile-revoked") {
            setUserProfileRole(profile.profileId, "none");
          } else if (scenario === "replaced") {
            await replaceSessionEntry(target, sessionEntry("replacement-id", profile.profileId, 2));
          }
          releaseWriter.resolve();
          const response = await pending;
          const archiveAllowed = scenario === "allowed" || scenario === "reassigned";
          expect(response, JSON.stringify(response)).toMatchObject({
            result: { isError: !archiveAllowed },
          });
          const entry = expectDefined(await readSessionEntryInWorker(target), "persisted target");
          expect({ sessionId: entry.sessionId, archivedAt: entry.archivedAt }).toEqual({
            sessionId: scenario === "replaced" ? "replacement-id" : targetId,
            archivedAt: archiveAllowed ? expect.any(Number) : undefined,
          });
        } finally {
          releaseWriter.resolve();
          await pending?.catch(() => {});
          requestSpy.mockRestore();
          if (grantToken) {
            revokeMcpLoopbackClientGrant(grantToken);
          }
          admission.close();
        }
      };
      const resources = new LegacyPluginSdkResourceHost();
      try {
        await resources.run(() =>
          withLocalGatewayRequestScope(
            { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
            async () => {
              await ensureMcpLoopbackServer();
              try {
                const scope = expectDefined(
                  getPluginRuntimeGatewayRequestScope(),
                  "local Gateway request scope",
                );
                await withPluginRuntimeGatewayRequestScope({ ...scope, client }, () =>
                  withOperatorToolGatewayAuthority(
                    {
                      authenticatedUserProfile: profile,
                      scopes: ["operator.write"],
                    },
                    archive,
                  ),
                );
              } finally {
                await closeMcpLoopbackServer();
              }
            },
          ),
        );
      } finally {
        await resources.close();
      }
    });
  },
);
