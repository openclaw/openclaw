import { expect, it } from "vitest";
import { createTestOperatorAuthority } from "../../agents/admitted-run-context.test-support.js";
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
    /** Profile of the admitted operator authority the caller already holds. */
    admittedAs?: string;
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
  // Owner status is the admitted grant's owner bit, or an asserted channel owner's config match.
  // Scopes without admission grant nothing.
  it.each([
    row("admitted admin CLI", true, true, { admittedAs: "gateway-owner" }),
    row("admitted write CLI", false, false, { admittedAs: "gateway-owner" }),
    row("unadmitted admin-scoped CLI", true, false),
    row("authenticated operator admin", true, true, { authenticatedProfile: true }),
    row("authenticated operator write", false, false, { authenticatedProfile: true }),
    row("authenticated operator continuation", true, true, {
      authenticatedProfile: true,
      requesterOrigin: origin(),
    }),
    row("operator admin continuation", true, true, {
      admittedAs: "operator-alice",
      requesterOrigin: operator,
    }),
    row("operator write continuation", false, false, {
      admittedAs: "operator-alice",
      requesterOrigin: operator,
    }),
    row("operator admin carrying external origin", true, true, {
      admittedAs: "operator-alice",
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
    row("unadmitted System admin", true, false, { requesterOrigin: origin() }),
  ])(
    "resolves admitted ownership for $name",
    async ({
      admin,
      expectedOwner,
      authenticatedProfile,
      admittedAs,
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
      const operatorRunAuthority = admittedAs
        ? createTestOperatorAuthority({ profileId: admittedAs, scopes })
        : undefined;
      const actorProfileId = profile?.id ?? (requesterOrigin ? admittedAs : undefined);
      const client = requesterOrigin
        ? createSyntheticPluginRuntimeClient({
            scopes,
            operatorRoleActor: actorProfileId
              ? { kind: "operator", profileId: actorProfileId }
              : { kind: "system" },
            operatorRunAuthority,
            agentToolCaller: { agentId: "main", sessionKey: "agent:main:source", requesterOrigin },
          })
        : {
            ...operatorWriteCliClient(scopes),
            ...(operatorRunAuthority ? { internal: { operatorRunAuthority } } : {}),
          };
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
        const representedProfileId = profile?.id ?? admittedAs;
        expect(admissionFacts).toMatchObject({
          invoker: principal("agent", "main"),
          ...(representedProfileId
            ? { representedSubject: principal("person", representedProfileId) }
            : {}),
        });
        if (!representedProfileId) {
          expect(admissionFacts?.representedSubject).toBeUndefined();
        }
      }
      expect(availableTools).toEqual(
        expectedOwner && !expectedSenderRestriction ? ["read", "exec"] : ["read"],
      );
    },
  );
}
