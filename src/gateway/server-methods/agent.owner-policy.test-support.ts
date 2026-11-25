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
  type OriginOptions = {
    authenticatedProfile?: true;
    requesterOrigin?: RequesterOrigin;
    ownerAllowFrom?: string[];
    expectedSenderRestriction?: true;
  };
  const origin = (fields: Omit<RequesterOrigin, "sessionKey"> = {}): RequesterOrigin => ({
    sessionKey: "agent:main:source",
    ...fields,
  });
  const operator = origin({ operatorProfileId: "operator-alice" });
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: "agent:main:source",
    sourceTool: "sessions_send",
  };
  const principal = (kind: string, ref: string) => ({
    state: "present",
    kind,
    rawPrincipalRef: ref,
  });
  const row = (
    name: string,
    admin: boolean,
    expectedOwner: boolean,
    options: OriginOptions = {},
  ) => ({ name, admin, expectedOwner, ...options });
  it.each([
    row("direct admin", true, true),
    row("direct write", false, false),
    row("authenticated operator admin", true, true, { authenticatedProfile: true }),
    row("authenticated operator write", false, false, { authenticatedProfile: true }),
    row("authenticated operator continuation", true, true, {
      authenticatedProfile: true,
      requesterOrigin: origin(),
    }),
    row("operator admin continuation", true, true, { requesterOrigin: operator }),
    row("operator write continuation", false, false, { requesterOrigin: operator }),
    row("operator admin carrying external origin", true, true, {
      requesterOrigin: { ...operator, messageProvider: "telegram", senderId: "alice" },
      expectedSenderRestriction: true,
    }),
    row("configured external owner by preserved E164", false, true, {
      requesterOrigin: origin({
        messageProvider: "whatsapp",
        senderId: "123456789@lid",
        senderE164: "+15555550123",
      }),
      ownerAllowFrom: ["whatsapp:+15555550123"],
      expectedSenderRestriction: true,
    }),
    row("System admin with session-only origin", true, true, { requesterOrigin: origin() }),
    row("System admin with internal origin", true, true, {
      requesterOrigin: origin({ messageProvider: "webchat" }),
    }),
    row("System admin carrying incomplete external origin", true, false, {
      requesterOrigin: origin({ messageProvider: "telegram" }),
    }),
    row("System write with session-only origin", false, false, { requesterOrigin: origin() }),
  ])(
    "resolves admitted ownership for $name",
    async ({
      admin,
      expectedOwner,
      authenticatedProfile,
      requesterOrigin: providedOrigin,
      ownerAllowFrom,
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
        const { id: profileId, displayName, updatedAt } = profile;
        client.authenticatedUserProfile = { profileId, displayName, hasAvatar: false, updatedAt };
      }
      await invokeAgent(
        {
          message: "owner tool check",
          replyChannel: "webchat",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "test-sender-owner",
          ...(requesterOrigin ? { inputProvenance } : {}),
        },
        { reqId: "sender-owner", client },
      );
      const callArgs = await waitForAgentCommandCall();
      expect(callArgs).toMatchObject({
        senderIsOwner: expectedOwner,
        ...(requesterOrigin ? { requesterOrigin } : {}),
        userTurnTranscriptRecorder: {
          message: { __openclaw: { senderIsOwner: requesterOrigin ? false : expectedOwner } },
        },
      });
      if (requesterOrigin) {
        expect(admissionFacts).toMatchObject({
          invoker: principal("agent", "main"),
          ...(profile ? { representedSubject: principal("person", profile.id) } : {}),
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
