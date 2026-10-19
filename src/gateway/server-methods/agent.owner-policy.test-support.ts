import { expect, it } from "vitest";
import { getAgentCommandAdmissionFacts } from "../../agents/agent-command-admission-facts.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import type { RequesterOrigin } from "../../agents/requester-origin.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import {
  getAgentTestMocks,
  primeMainAgentRun,
  operatorWriteCliClient,
  waitForAgentCommandCall,
  invokeAgent,
} from "./agent.test-harness.js";

export function registerAgentOwnerPolicyCases(): void {
  const mocks = getAgentTestMocks();
  it.each<{
    name: string;
    admin: boolean;
    authenticatedProfile?: true;
    requesterOrigin?: RequesterOrigin;
    ownerAllowFrom?: string[];
    expectedOwner: boolean;
    expectedSenderRestriction?: true;
  }>([
    { name: "direct admin", admin: true, expectedOwner: true },
    { name: "direct write", admin: false, expectedOwner: false },
    {
      name: "authenticated operator admin",
      admin: true,
      authenticatedProfile: true,
      expectedOwner: true,
    },
    {
      name: "authenticated operator write",
      admin: false,
      authenticatedProfile: true,
      expectedOwner: false,
    },
    {
      name: "authenticated operator continuation",
      admin: true,
      authenticatedProfile: true,
      requesterOrigin: { sessionKey: "agent:main:source" },
      expectedOwner: true,
    },
    {
      name: "operator admin continuation",
      admin: true,
      requesterOrigin: { sessionKey: "agent:main:source", operatorProfileId: "operator-alice" },
      expectedOwner: true,
    },
    {
      name: "operator write continuation",
      admin: false,
      requesterOrigin: { sessionKey: "agent:main:source", operatorProfileId: "operator-alice" },
      expectedOwner: false,
    },
    {
      name: "operator admin carrying external origin",
      admin: true,
      requesterOrigin: {
        sessionKey: "agent:main:source",
        operatorProfileId: "operator-alice",
        messageProvider: "telegram",
        senderId: "alice",
      },
      expectedOwner: true,
      expectedSenderRestriction: true,
    },
    {
      name: "configured external owner by preserved E164",
      admin: false,
      requesterOrigin: {
        sessionKey: "agent:main:source",
        messageProvider: "whatsapp",
        senderId: "123456789@lid",
        senderE164: "+15555550123",
      },
      ownerAllowFrom: ["whatsapp:+15555550123"],
      expectedOwner: true,
      expectedSenderRestriction: true,
    },
    {
      name: "System admin with session-only origin",
      admin: true,
      requesterOrigin: { sessionKey: "agent:main:source" },
      expectedOwner: true,
    },
    {
      name: "System admin with internal origin",
      admin: true,
      requesterOrigin: { sessionKey: "agent:main:source", messageProvider: "webchat" },
      expectedOwner: true,
    },
    {
      name: "System admin carrying incomplete external origin",
      admin: true,
      requesterOrigin: { sessionKey: "agent:main:source", messageProvider: "telegram" },
      expectedOwner: false,
    },
    {
      name: "System write with session-only origin",
      admin: false,
      requesterOrigin: { sessionKey: "agent:main:source" },
      expectedOwner: false,
    },
  ])(
    "resolves admitted ownership for $name",
    async ({
      admin,
      authenticatedProfile,
      requesterOrigin: providedOrigin,
      ownerAllowFrom,
      expectedOwner,
      expectedSenderRestriction,
    }) => {
      const cfg = {
        ...(ownerAllowFrom ? { commands: { ownerAllowFrom } } : {}),
        tools: { toolsBySender: { "*": { deny: ["exec"] } } },
      };
      mocks.loadConfigReturn = cfg;
      primeMainAgentRun({ cfg });
      mocks.agentCommand.mockClear();
      let availableTools: string[] | undefined;
      let admissionFacts: ReturnType<typeof getAgentCommandAdmissionFacts>;
      mocks.agentCommand.mockImplementation(async (opts: AgentCommandGatewayIngressOpts) => {
        admissionFacts = getAgentCommandAdmissionFacts(opts.runContext ?? opts);
        availableTools = projectConversationToolNames({
          capabilityProfile: resolveConversationCapabilityProfile({
            ...opts,
            workspaceDir: opts.workspaceDir ?? undefined,
            config: cfg,
          }),
          toolNames: ["read", "exec"],
          warn: () => undefined,
        });
        return { payloads: [{ text: "ok" }], meta: {} };
      });
      const scopes = [admin ? "operator.admin" : "operator.write"];
      const profile = authenticatedProfile
        ? ensureProfileForEmail("owner-policy@example.test")
        : undefined;
      const requesterOrigin =
        profile && providedOrigin
          ? { ...providedOrigin, operatorProfileId: profile.id }
          : providedOrigin;
      const client = requesterOrigin
        ? createSyntheticPluginRuntimeClient({
            scopes,
            operatorRoleActor: profile
              ? { kind: "operator", profileId: profile.id }
              : { kind: "system" },
            agentToolCaller: { agentId: "main", sessionKey: "agent:main:source", requesterOrigin },
          })
        : operatorWriteCliClient(scopes);
      if (profile) {
        client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: profile.displayName,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
      }
      await invokeAgent(
        {
          message: "owner tool check",
          replyChannel: "webchat",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "test-sender-owner",
          ...(requesterOrigin
            ? {
                inputProvenance: {
                  kind: "inter_session" as const,
                  sourceSessionKey: "agent:main:source",
                  sourceTool: "sessions_send",
                },
              }
            : {}),
        },
        { reqId: "sender-owner", client },
      );
      const callArgs = await waitForAgentCommandCall();
      expect(callArgs).toMatchObject({
        senderIsOwner: expectedOwner,
        userTurnTranscriptRecorder: {
          message: { __openclaw: { senderIsOwner: requesterOrigin ? false : expectedOwner } },
        },
      });
      if (requesterOrigin) {
        expect(callArgs).toMatchObject({ requesterOrigin });
        expect(admissionFacts).toMatchObject({
          invoker: { state: "present", kind: "agent", rawPrincipalRef: "main" },
          ...(profile
            ? {
                representedSubject: {
                  state: "present",
                  kind: "person",
                  rawPrincipalRef: profile.id,
                },
              }
            : {}),
        });
        if (!profile) {
          expect(admissionFacts?.representedSubject).toBeUndefined();
        }
      }
      expect(availableTools).toEqual(
        expectedOwner && !expectedSenderRestriction ? ["read", "exec"] : ["read"],
      );
    },
  );
}
