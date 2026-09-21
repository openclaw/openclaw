import { expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { CliDeps } from "../cli/deps.types.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  revokeAttachGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

it("binds non-owner MCP assignment to admitted authority through the durable owner write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:dashboard:assignment";
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
      tools: { allow: ["sessions"] },
    };
    await state.writeConfig(cfg);
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId: "assignment-session",
      updatedAt: 1,
      createdActor: { type: "agent", id: "main" },
      visibility: "shared",
    });
    const profile = ensureProfileForEmail("assignment-requester@example.test");
    await withLocalGatewayRequestScope(
      { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
      async () => {
        await ensureMcpLoopbackServer();
        const runtime = getActiveMcpLoopbackRuntime();
        const gateway = getPluginRuntimeGatewayRequestScope()?.context;
        if (!runtime || !gateway) {
          throw new Error("missing isolated MCP/Gateway fixture");
        }
        const admission = prepareAgentRunAdmission({
          cfg,
          facts: {
            runId: "assignment-run",
            agentId: "main",
            ingress: { kind: "system", boundary: "assignment-test", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef("assignment-run"),
        });
        const admittedRunContext = await admission.admit("gateway", "assignment-execution");
        const grant = mintMcpLoopbackClientGrant({
          context: {
            sessionKey,
            senderIsOwner: false,
            runId: "assignment-run",
            toolsAllow: ["sessions"],
          },
          runtimeOwnerToken: runtime.ownerToken,
          admittedRunContext,
        });
        const capture = activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken: runtime.ownerToken,
          captureKey: "assignment-capture",
        });
        expect(capture).toBeDefined();
        const attach = mintAttachGrant({ sessionKey, agentId: "main" });
        const request = async (
          token: string,
          attached: boolean,
          method: "tools/list" | "tools/call",
          ownerId = profile.id,
        ) => {
          const response = await fetch("http://127.0.0.1:" + runtime.port + "/mcp", {
            method: "POST",
            headers: {
              authorization: "Bearer " + token,
              "content-type": "application/json",
              ...(attached ? {} : { "x-openclaw-cli-capture-key": "assignment-capture" }),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              ...(method === "tools/call"
                ? {
                    params: {
                      name: "sessions",
                      arguments: { action: "assign_owner", ownerType: "human", ownerId },
                    },
                  }
                : {}),
            }),
          });
          const payload = await response.json();
          expect(response.status, JSON.stringify(payload)).toBe(200);
          return payload as {
            result?: { tools?: Array<{ name: string }>; isError?: boolean };
            error?: unknown;
          };
        };
        try {
          expect(
            (await request(grant.token, false, "tools/list")).result?.tools?.some(
              (tool) => tool.name === "sessions",
            ),
          ).toBe(true);
          expect(await request(grant.token, false, "tools/call")).toMatchObject({
            result: { isError: false },
          });
          expect(loadSessionEntry(scope)).toMatchObject({
            owner: {
              actor: { type: "human", id: profile.id },
              assignedBy: { type: "agent", id: "main" },
            },
            createdActor: { type: "agent", id: "main" },
            visibility: "shared",
          });
          const before = loadSessionEntry(scope)?.owner;
          const next = ensureProfileForEmail("other-requester@example.test");
          const denied = await request(attach.token, true, "tools/call", next.id);
          expect(denied).toMatchObject({
            result: {
              isError: true,
              content: [{ type: "text", text: "Tool not available: sessions" }],
            },
          });
          expect.soft(loadSessionEntry(scope)?.owner).toEqual(before);
          expect
            .soft(
              (await request(attach.token, true, "tools/list")).result?.tools?.some(
                (tool) => tool.name === "sessions",
              ),
            )
            .toBe(false);
          let revoke = true;
          gateway.getRuntimeConfig = () => {
            if (revoke) {
              revoke = false;
              revokeMcpLoopbackClientGrant(grant.token);
            }
            return cfg;
          };
          const retired = await request(grant.token, false, "tools/call", next.id);
          expect(retired).toMatchObject({
            result: {
              isError: true,
              content: [
                { type: "text", text: expect.stringMatching(/authority.*no longer active/i) },
              ],
            },
          });
          expect(loadSessionEntry(scope)?.owner).toEqual(before);
        } finally {
          revokeAttachGrant(attach.token);
          revokeMcpLoopbackClientGrant(grant.token);
          admission.close();
          await closeMcpLoopbackServer();
        }
      },
    );
  });
});
