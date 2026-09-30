import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  buildCliMcpGrantContext,
  finalizeCliMcpGrant,
} from "../agents/cli-runner/mcp-grant-context.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import * as gatewayRequests from "../agents/tools/in-process-gateway.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import { createLibrarySkillWorkshopTool } from "../agents/tools/skill-workshop-tool-library.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import {
  readOkMcpPayload,
  sendLoopbackToolCall,
  startLoopbackServerForTest,
} from "./mcp-http.test-support.js";
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

let runtime: Awaited<ReturnType<typeof startLoopbackServerForTest>>["runtime"];
beforeAll(async () => {
  ({ runtime } = await startLoopbackServerForTest());
});
afterAll(async () => {
  await closeMcpLoopbackServer();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "carries personal Workshop and live session-tool authority outside cloned grant context (assignment only: %s)",
  async (assignmentOnly) => {
    await withPersonalToolTurn(
      {
        owner: { profileId: "alice", senderId: "alice", name: "Alice" },
        runId: "run-library-grant",
        sessionKey: "agent:main:library",
        sessionId: "library-session",
      },
      async (turn) => {
        const invoke = vi.fn(async () => {
          const caller = getGatewayToolCallerIdentity();
          expect(caller?.operationalRunInstance).toBe(
            turn.admittedRunContext.operationalRunInstance,
          );
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
        const context = buildCliMcpGrantContext({
          run: {
            sessionId: "library-session",
            sessionKey: "agent:main:library",
            sessionFile: "/tmp/library-session",
            workspaceDir: "/tmp/library-workspace",
            provider: "test-cli",
            prompt: "List my skills",
            timeoutMs: 1_000,
            runId: "run-library-grant",
            skillLibraryAuthoring,
          },
          config: {},
          requireExplicitMessageTarget: false,
          agentId: "main",
          modelProvider: "openai",
          modelId: "gpt-5.6-luna",
        });
        const preparedGrant = finalizeCliMcpGrant(context, undefined, false);
        if (!preparedGrant) {
          throw new Error("Expected prepared CLI grant");
        }
        const grant = mintMcpLoopbackClientGrant({
          ...preparedGrant,
          runtimeOwnerToken: runtime.ownerToken,
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
        resolveTools.mockImplementation((input) => {
          const capability = input.skillWorkshop?.libraryAuthoring;
          return {
            agentId: "main",
            workspaceDir: "/tmp/library-workspace",
            captureFinalCronCreatorTools: undefined,
            tools: capability
              ? [
                  createLibrarySkillWorkshopTool(capability),
                  createSessionsTool({
                    senderIsOwner: assignmentOnly ? false : undefined,
                    agentSessionKey: "agent:main:library",
                    config: {},
                  }),
                ]
              : [],
          };
        });
        const captureKey = "capture-library-grant";
        activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken: runtime.ownerToken,
          captureKey,
        });
        const call = async (name: string, args: Record<string, unknown>) =>
          readOkMcpPayload(
            await sendLoopbackToolCall({
              token: grant.token,
              name,
              args,
              headers: { "x-openclaw-cli-capture-key": captureKey },
            }),
          );
        const workshop = await call("skill_workshop", { action: "list" });
        expect(workshop.result?.isError).toBe(false);
        expect(JSON.parse(String(workshop.result?.content?.[0]?.text))).toMatchObject({
          entries: [],
          omitted: 0,
        });
        expect(invoke).toHaveBeenCalledOnce();

        const sessions = (user?: string) =>
          call("sessions", {
            ...(assignmentOnly
              ? { action: "assign_owner", ownerType: "agent", ownerId: "main" }
              : { action: "group_list" }),
            ...(user ? { user } : {}),
          });
        expect((await sessions()).result?.isError).toBe(false);
        expect(await turn.steer({ profileId: "bob", senderId: "bob", name: "Bob" })).toMatchObject({
          status: "accepted",
        });
        const ambiguous = await sessions();
        expect(ambiguous.result?.isError).toBe(true);
        expect(ambiguous.result?.content?.[0]?.text).toContain("Alice (user: alice)");
        expect(ambiguous.result?.content?.[0]?.text).toContain("Bob (user: bob)");
        expect((await sessions("bob")).result?.isError).toBe(false);
        expect((await sessions("alice")).result?.isError).toBe(false);
        expect((await sessions("unknown")).result?.isError).toBe(true);
        turn.revoke("bob");
        expect((await sessions("bob")).result?.isError).toBe(true);
        expect((await sessions("alice")).result?.isError).toBe(false);
        turn.complete();
        expect((await sessions("alice")).result?.isError).toBe(true);
        expect(callGateway).toHaveBeenCalledTimes(4);
      },
    );
  },
);
