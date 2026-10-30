import { expect, it, vi } from "vitest";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import * as gatewayRequests from "../agents/tools/in-process-gateway.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import { createLibrarySkillWorkshopTool } from "../agents/tools/skill-workshop-tool-library.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import * as grants from "./mcp-grant-store.js";
import * as mcp from "./mcp-http.test-support.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const resolveTools = vi.hoisted(() => vi.fn<typeof resolveGatewayScopedTools>());
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => ({ session: { mainKey: "main" } }),
}));
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
vi.mock("../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "eligible", isAvailable: () => true }),
}));

const runtime = mcp.useLoopbackServerForTest();

it.each([false, true])(
  "carries personal Workshop and live session-tool authority outside cloned grant context (assignment only: %s)",
  async (assignmentOnly) => {
    const alice = { profileId: "alice", senderId: "alice", name: "Alice" };
    const session = {
      runId: "run-library-grant",
      sessionKey: "agent:main:library",
      sessionId: "library-session",
    };
    await withPersonalToolTurn({ ...session, owner: alice }, async (turn) => {
      const invoke = vi.fn(async () => {
        const caller = getGatewayToolCallerIdentity();
        expect(caller?.operationalRunInstance).toBe(turn.admittedRunContext.operationalRunInstance);
        expect(caller?.receiptAuthority?.()).toBe(true);
        return {
          entries: [],
          profileId: "requester",
          multipleProfiles: true,
          defaultTarget: "personal" as const,
          canManageWorkspace: false,
          defaultSelectionLimit: 64,
        };
      });
      const skillLibraryAuthoring: SkillLibraryAuthoringCapability = {
        target: "personal",
        defaultTarget: "personal",
        multipleProfiles: true,
        bind: () => {},
        invoke,
      };
      const config = { session: { mainKey: "main" } };
      const grant = grants.mintMcpLoopbackClientGrant({
        context: {
          ...session,
          workspaceDir: "/tmp/library-workspace",
          agentId: "main",
          senderIsOwner: false,
          nodeExecAllowed: true,
        },
        toolPolicyConfig: config,
        runtimeOwnerToken: runtime().ownerToken,
        admittedRunContext: turn.admittedRunContext,
        personalToolParticipants: turn.operation.personalToolParticipants,
        skillLibraryAuthoring,
      });
      expect(grant.context).not.toHaveProperty("skillWorkshop.libraryAuthoring");
      expect(grant.context).not.toHaveProperty("personalToolParticipants");
      const callGateway = vi
        .spyOn(gatewayRequests, "callAgentToolGatewayRequest")
        .mockResolvedValue({
          groups: [],
          key: "agent:main:library",
          owner: { actor: { type: "agent", id: "main" } },
        })
        .mockClear();
      resolveTools.mockImplementation(async (input) => {
        const capability = input.skillWorkshop?.libraryAuthoring;
        return mcp.scopedToolFixture(
          capability
            ? [
                createLibrarySkillWorkshopTool(capability),
                createSessionsTool({
                  senderIsOwner: assignmentOnly ? false : undefined,
                  agentSessionKey: session.sessionKey,
                  config: {},
                }),
              ]
            : [],
          "/tmp/library-workspace",
        );
      });
      const captureKey = "capture-library-grant";
      mcp.captureGrant(grant.token, captureKey, runtime().ownerToken);
      const request = (name: string, args: Record<string, unknown>) =>
        mcp.sendLoopbackToolCall({
          token: grant.token,
          name,
          args,
          headers: { "x-openclaw-cli-capture-key": captureKey },
        });
      const call = async (name: string, args: Record<string, unknown>) =>
        mcp.readOkMcpPayload(await request(name, args));
      const workshop = await call("skill_workshop", { action: "list" });
      expect(workshop.result?.isError).toBe(false);
      expect(JSON.parse(String(workshop.result?.content?.[0]?.text))).toMatchObject({
        entries: [],
        omitted: 0,
      });
      expect(invoke).toHaveBeenCalledOnce();

      const requestSessions = (user?: string) =>
        request("sessions", {
          ...(assignmentOnly
            ? { action: "assign_owner", ownerType: "agent", ownerId: "main" }
            : { action: "group_list" }),
          ...(user ? { user } : {}),
        });
      const sessions = async (user?: string) => mcp.readOkMcpPayload(await requestSessions(user));
      const expectUnauthorizedSessions = async () => {
        const response = await requestSessions("alice");
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
      };
      expect((await sessions()).result?.isError).toBe(false);
      expect(await turn.steer({ profileId: "bob", senderId: "bob", name: "Bob" })).toMatchObject({
        status: "rejected",
        reason: "tool_authority_mismatch",
      });
      expect((await sessions()).result?.isError).toBe(false);
      expect((await sessions("bob")).result?.isError).toBe(true);
      expect(await turn.steer({ ...alice, senderId: "reconnected" })).toMatchObject({
        status: "accepted",
      });
      expect((await sessions("alice")).result?.isError).toBe(false);
      expect((await sessions("unknown")).result?.isError).toBe(true);
      turn.revoke("alice");
      await expectUnauthorizedSessions();
      await turn.complete();
      await expectUnauthorizedSessions();
      expect(callGateway).toHaveBeenCalledTimes(3);
    });
  },
);
