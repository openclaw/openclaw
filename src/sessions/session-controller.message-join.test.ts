import { afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  bindReplyInputChannel,
  bindWorkerToolPreparation,
  isToolAuthorityReadCaptureActive,
} from "../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../agents/harness/tool-authority-preparation.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { bindCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { withMessageInjectionAdmission } from "../auto-reply/reply/message-injection-authority.js";
import { resolveInboundReplyToolAuthorityOverlay } from "../auto-reply/reply/reply-tool-authority-inbound.js";
import {
  prepareReplyRunToolAuthority,
  prepareReplyToolAuthority,
} from "../auto-reply/reply/reply-tool-authority.js";
import {
  createQueueTestRun,
  toolAuthorityOverlay,
} from "../auto-reply/reply/reply-tool-authority.test-support.js";
import { prepareSteeringDelivery } from "../auto-reply/reply/steering-delivery-preparation.js";
import { bindRequesterProfile } from "../auto-reply/requester-profile.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureGatewayAuthPolicy } from "../gateway/auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
import type { GatewayClient } from "../gateway/server-methods/client-types.js";
import {
  dispatchProfile,
  gatewayConnect,
  operatorRecoverySnapshotFixture,
} from "../gateway/server/client-fixtures.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withSessionTurn } from "./session-controller.admission.js";
import {
  captureReplyExecutionSelection,
  captureReplySessionExecutionSelection,
} from "./session-controller.execution-selection.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
} from "./session-controller.message-injection.js";
import { prepareReplyMessageJoin } from "./session-controller.message-join.js";
import { testing } from "./session-controller.test-support.js";
import { createReplyTurnParticipants } from "./session-controller.tool-authority.js";

afterEach(() => testing.resetSessionControllerForTest());

it("copies private turn participants and freezes only their shared command target", () => {
  let current = true;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "participant",
    scopes: ["operator.read"],
    assertCurrent() {
      if (!current) {
        throw new Error("revoked");
      }
    },
  });
  const freeze = vi.spyOn(Object, "freeze");
  const participants = createReplyTurnParticipants({
    operatorAuthority: authority,
    senderId: "original",
    gatewayUiCommandTarget: { connId: "original", profileId: "participant" },
  });
  try {
    expect(freeze).toHaveBeenCalledTimes(1);
    const exposed = participants.resolve()!;
    Object.assign(exposed, { senderId: "changed", name: "changed" });
    expect(Reflect.set(exposed.gatewayUiCommandTarget!, "connId", "changed")).toBe(false);
    expect(participants.resolve()).toMatchObject({
      senderId: "original",
      gatewayUiCommandTarget: { connId: "original", profileId: "participant" },
    });
    current = false;
    expect(() => exposed.assertCurrent()).toThrow("access changed");
  } finally {
    freeze.mockRestore();
    participants.close();
  }
});

type JoinCase = {
  differentConversation?: true;
  legacy?: true;
  profile?: "pin" | "auto" | "legacy-pin" | "legacy-auto";
  headless?: true;
  caps?: "expand" | "narrow" | "protocol";
  target?: "new" | "removed" | "foreign";
  mismatch?: "profile" | "tools" | "elevation" | "exec" | "workspace" | "cwd" | "scopes" | "model";
  after?:
    | "settings"
    | "activity"
    | "revoke"
    | "caller-revoke"
    | "backend"
    | "delivery"
    | "link-revoke"
    | "identity-disconnect"
    | "owner-revoke"
    | "shared-revoke";
  crossSurface?: "incoming" | "outgoing" | "different" | "shared" | "delegated" | "initiator";
  linkedBot?: "incoming" | "incumbent";
  sharedOwner?: {
    direction: "incoming" | "outgoing";
    channelOwner?: false;
    collaborative?: true;
    webSource?: "personal" | "forged";
    webAdmin?: false;
    routedBrowser?: true;
    differentSession?: true;
    bot?: true;
  };
  sessionOnly?: true;
};
type Outcome = "accepted" | "deferred" | "rejected" | "revoked" | "failed";
const uiTarget = (connId: string, profileId = "join-owner") => ({ connId, profileId });

it.each<[string, Outcome, JoinCase?]>([
  ["resolved defaults", "accepted"],
  ["unqualified profile pin", "deferred", { profile: "pin" }],
  ["legacy profile pin", "deferred", { profile: "legacy-pin" }],
  ["legacy automatic profile", "accepted", { profile: "legacy-auto" }],
  ["automatic profile rotation", "accepted", { profile: "auto" }],
  ["caps-only", "accepted", { headless: true, caps: "expand" }],
  ["headless-to-web", "accepted", { headless: true, caps: "expand", target: "new" }],
  ["protocol-only", "accepted", { caps: "protocol" }],
  ["narrower caps", "accepted", { caps: "narrow" }],
  [
    "another conversation with changed policy",
    "deferred",
    { mismatch: "tools", differentConversation: true },
  ],
  ["new target", "accepted", { headless: true, target: "new" }],
  ["removed target", "accepted", { target: "removed" }],
  ["changed non-owner target", "accepted", { target: "foreign" }],
  ["cross-profile caps", "deferred", { headless: true, caps: "expand", mismatch: "profile" }],
  ["missing selection compatible", "accepted", { legacy: true }],
  ["missing selection expanded caps", "deferred", { legacy: true, caps: "expand" }],
  ["session-only", "accepted", { sessionOnly: true }],
  ["current tool policy", "accepted", { mismatch: "tools" }],
  ["saved elevation", "deferred", { mismatch: "elevation" }],
  ["exec configuration", "deferred", { mismatch: "exec" }],
  ["workspace", "deferred", { mismatch: "workspace" }],
  ["saved working directory", "deferred", { mismatch: "cwd" }],
  ["narrowed scopes", "accepted", { mismatch: "scopes" }],
  ["revoked after preparation", "revoked", { after: "revoke" }],
  ["incoming authority revoked independently", "rejected", { after: "caller-revoke" }],
  ["replaced backend", "rejected", { after: "backend" }],
  ["saved settings after preparation", "rejected", { after: "settings" }],
  ["activity after preparation", "accepted", { after: "activity" }],
  ["delivery closed before final submission", "rejected", { after: "delivery" }],
  ["linked channel guides WebUI authority", "accepted", { crossSurface: "incoming" }],
  ["WebUI guides linked channel authority", "accepted", { crossSurface: "outgoing" }],
  [
    "linked bot cannot guide human authority",
    "deferred",
    { crossSurface: "incoming", linkedBot: "incoming" },
  ],
  [
    "linked bot execution cannot use human continuation",
    "deferred",
    { crossSurface: "outgoing", linkedBot: "incumbent" },
  ],
  ["different linked human", "deferred", { crossSurface: "different" }],
  [
    "different linked human with changed model",
    "deferred",
    { crossSurface: "different", mismatch: "model" },
  ],
  [
    "linked requester with changed model",
    "deferred",
    { crossSurface: "incoming", mismatch: "model" },
  ],
  ["shared owner is not personal identity", "deferred", { crossSurface: "shared" }],
  ["selected delegate requester", "accepted", { crossSurface: "delegated" }],
  ["causal initiator is not selected requester", "deferred", { crossSurface: "initiator" }],
  [
    "linked identity revoked before submission",
    "failed",
    { crossSurface: "incoming", after: "link-revoke" },
  ],
  [
    "incumbent identity outlives ingress connection",
    "accepted",
    { crossSurface: "outgoing", after: "identity-disconnect" },
  ],
  ["channel owner guides shared WebUI", "accepted", { sharedOwner: { direction: "incoming" } }],
  ["shared WebUI guides channel owner", "accepted", { sharedOwner: { direction: "outgoing" } }],
  [
    "bot owner cannot use human Shared Owner continuation",
    "deferred",
    { sharedOwner: { direction: "incoming", bot: true } },
  ],
  [
    "claimed channel ownership is not authority",
    "deferred",
    { sharedOwner: { direction: "incoming", channelOwner: false } },
  ],
  [
    "collaborative channel guides shared WebUI",
    "accepted",
    { sharedOwner: { direction: "incoming", channelOwner: false, collaborative: true } },
  ],
  [
    "shared WebUI guides collaborative channel",
    "accepted",
    { sharedOwner: { direction: "outgoing", channelOwner: false, collaborative: true } },
  ],
  [
    "browser delivery through a channel is not channel ingress",
    "deferred",
    {
      sharedOwner: {
        direction: "incoming",
        channelOwner: false,
        collaborative: true,
        routedBrowser: true,
      },
    },
  ],
  [
    "shared WebUI without admin cannot guide a channel owner",
    "deferred",
    { sharedOwner: { direction: "outgoing", webAdmin: false } },
  ],
  [
    "personal admin is not shared WebUI authority",
    "deferred",
    { sharedOwner: { direction: "incoming", webSource: "personal" } },
  ],
  [
    "owner profile and auth facts do not mint shared authority",
    "deferred",
    { sharedOwner: { direction: "incoming", webSource: "forged" } },
  ],
  [
    "shared continuation requires the same session",
    "deferred",
    { sharedOwner: { direction: "incoming", differentSession: true } },
  ],
  [
    "channel ownership revoked before submission",
    "failed",
    { sharedOwner: { direction: "incoming" }, after: "owner-revoke" },
  ],
  [
    "shared WebUI authority revoked before submission",
    "failed",
    { sharedOwner: { direction: "outgoing" }, after: "shared-revoke" },
  ],
])(
  "joins the selected execution with current admission checks: %s",
  async (name, outcome, c = {}) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const key = `agent:main:join-${name.replaceAll(" ", "-")}`;
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      if (c.sharedOwner) {
        cfg.messages = {
          queue: { allowCollaborativeSteering: c.sharedOwner.collaborative === true },
        };
      }
      setRuntimeConfigSnapshot(cfg);
      const entry: SessionEntry = {
        sessionId: "join-session",
        lifecycleRevision: "join-revision",
        updatedAt: 1,
        permissionMode: "full",
      };
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const address = { agentId: "main", sessionKey: key, storePath };
      await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
      const run = createQueueTestRun({ prompt: "original work", originatingChannel: "webchat" });
      Object.assign(run.run, {
        agentId: "main",
        agentDir: state.agentDir(),
        sessionKey: key,
        sessionId: entry.sessionId,
        workspaceDir: state.workspaceDir,
        messageProvider: "webchat",
        senderIsOwner: true,
        permissionMode: "full",
        config: cfg,
        traceAuthorized: false,
        clientCaps: c.headless ? [] : ["ui-commands"],
        gatewayUiCommandTarget:
          c.headless || c.caps === "protocol"
            ? undefined
            : uiTarget(
                "original-connection",
                c.target === "foreign" ? "destination-owner" : "join-owner",
              ),
      });
      if (c.profile === "pin" || c.profile === "auto") {
        run.run.authProfileId = "synthetic-profile-a";
        run.run.authProfileIdSource = c.profile === "auto" ? "auto" : undefined;
      }
      const original = structuredClone([run.run.clientCaps, run.run.gatewayUiCommandTarget]);
      const sourceRevocation = new AbortController();
      const assertSource = () => sourceRevocation.signal.throwIfAborted();
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "join-owner",
        scopes: ["operator.admin"],
        gatewayAccessGrant: null,
        modelPolicy: prepareOperatorModelPolicy({ cfg, policy: {} }),
        assertCurrent: assertSource,
      });
      const sharedRevocation = new AbortController();
      let sharedCapture: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
      if (c.sharedOwner && !c.sharedOwner.webSource) {
        ensureGatewayOwnerProfile(null);
        const client: GatewayClient = {
          connId: "shared-browser",
          connect: gatewayConnect(
            c.sharedOwner.webAdmin === false
              ? ["operator.read", "operator.write"]
              : ["operator.admin"],
          ),
          authenticatedUserProfile: dispatchProfile("gateway-owner"),
          usesSharedGatewayAuth: true,
          sharedGatewaySessionGeneration: "shared-test-generation",
          authPolicy: captureGatewayAuthPolicy(cfg, { role: "operator", authMethod: "token" }),
          internal: { authenticatedOperator: true, operatorRoleActor: { kind: "system" } },
        };
        sharedCapture = await captureGatewayOperatorRunAuthority({
          client,
          context: { getRuntimeConfig: () => cfg },
          sourceAuthority: {
            signal: sharedRevocation.signal,
            assertCurrent: () => sharedRevocation.signal.throwIfAborted(),
            gatewayAccessGrant: null,
          },
        });
        if (!sharedCapture) {
          throw new Error("Expected host-captured shared browser authority");
        }
      }
      using _ = { [Symbol.dispose]: () => sharedCapture?.release() };
      const webAuthority =
        sharedCapture?.authority ??
        (c.sharedOwner?.webSource === "forged"
          ? createAdmittedRunOperatorAuthority({
              ...operatorAuthority,
              profileId: "gateway-owner",
              recoverySnapshot: operatorRecoverySnapshotFixture("gateway-owner", "forged-grant", {
                controlUiAdmin: true,
                sourceIngress: "control-ui",
              }),
            })
          : operatorAuthority);
      let channelOwnerCurrent = true;
      run.operatorAuthority = operatorAuthority;
      let originalIdentityCurrent = true;
      let incomingIdentityCurrent = true;
      if (c.crossSurface) {
        const originalContext = {};
        bindRequesterProfile(originalContext, {
          id:
            c.crossSurface === "initiator" || c.crossSurface === "delegated"
              ? "initiator"
              : "join-owner",
          displayName: null,
          isCurrent: () => originalIdentityCurrent,
        });
        Object.assign(run, originalContext);
        if (c.crossSurface === "outgoing") {
          run.operatorAuthority = undefined;
          run.originatingChannel = "telegram";
          run.run.messageProvider = "telegram";
        } else if (c.crossSurface === "shared") {
          run.operatorAuthority = createAdmittedRunOperatorAuthority({
            ...operatorAuthority,
            profileId: "gateway-owner",
          });
        } else if (c.crossSurface === "initiator" || c.crossSurface === "delegated") {
          run.run.requesterOrigin = {
            sessionKey: key,
            operatorProfileId: "join-owner",
            delegatedCreatorProfileId: "initiator",
          };
        }
        bindReplyInputChannel(
          run.run,
          c.linkedBot === "incumbent" ? undefined : run.run.messageProvider,
        );
      }
      if (c.sharedOwner) {
        bindReplyInputChannel(
          run.run,
          c.sharedOwner.direction === "incoming" ? "webchat" : "telegram",
        );
        if (c.sharedOwner.direction === "incoming") {
          run.operatorAuthority = webAuthority;
        } else {
          run.operatorAuthority = undefined;
          run.originatingChannel = "telegram";
          run.run.messageProvider = "telegram";
          if (c.sharedOwner.channelOwner !== false) {
            bindCommandOwnerAuthority(run.run, { isCurrent: () => channelOwnerCurrent });
          }
        }
      }
      await withSessionTurn({ ...address, sessionId: entry.sessionId }, async (operation) => {
        if (!operation) {
          throw new Error("Expected direct execution owner");
        }
        await operation.bindToolAuthoritySnapshotAsync(
          c.legacy ? prepareReplyToolAuthority(run) : prepareReplyRunToolAuthority(run, entry),
        );
        const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
        const delivered = vi.fn();
        const replacement = vi.fn();
        const backend = {
          kind: "embedded" as const,
          toolAuthorityFingerprint: fingerprint,
          terminalReplyExpectation: "required" as const,
          cancel() {},
        };
        operation.attachBackend({
          ...backend,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            async queueMessage() {
              throw new Error("Expected prepared admission");
            },
            async queueMessageAsync(text, options, preparation) {
              await withMessageInjectionAdmission(preparation.prepareCurrent, () => {
                preparation.assertCurrent();
                delivered(text);
                options?.onQueueAccepted?.(true);
              });
            },
          },
        });
        operation.setPhase("running");
        const originalParticipant = structuredClone(
          operation.personalToolParticipants?.resolve()?.gatewayUiCommandTarget,
        );
        const target = captureReplyMessageInjectionTarget(operation);
        if (!target) {
          throw new Error("Expected captured target");
        }
        const incoming: typeof run = {
          ...run,
          prompt: "change the current work",
          run: {
            ...run.run,
            ...(c.legacy
              ? {}
              : {
                  traceAuthorized: true,
                  elevatedLevel: "off" as const,
                  bashElevated: { enabled: true, allowed: false, defaultLevel: "off" as const },
                }),
          },
        };
        if (c.crossSurface) {
          incoming.originatingChannel = c.crossSurface === "outgoing" ? "webchat" : "telegram";
          incoming.run.messageProvider = incoming.originatingChannel;
          incoming.run.senderId = "transport-specific-sender";
          incoming.run.requesterOrigin = undefined;
          incoming.operatorAuthority =
            c.crossSurface === "outgoing" ? operatorAuthority : undefined;
          incoming.toolsAllow = ["message"];
        }
        if (c.sharedOwner) {
          const fromWeb = c.sharedOwner.direction === "outgoing";
          incoming.originatingChannel = fromWeb ? "webchat" : "telegram";
          incoming.run.messageProvider = incoming.originatingChannel;
          incoming.run.senderId = "other-transport-requester";
          incoming.operatorAuthority = c.sharedOwner.routedBrowser
            ? operatorAuthority
            : fromWeb
              ? webAuthority
              : undefined;
          incoming.toolsAllow = ["message"];
          if (c.sharedOwner.differentSession) {
            incoming.run.sessionKey = "agent:main:another-session";
          }
        }
        const incomingRevocation = new AbortController();
        if (c.after === "caller-revoke") {
          incoming.operatorAuthority = createAdmittedRunOperatorAuthority({
            ...operatorAuthority,
            source: {},
            assertCurrent: () => incomingRevocation.signal.throwIfAborted(),
          });
        }
        if (c.caps) {
          incoming.run.clientCaps = c.caps === "narrow" ? [] : ["ui-commands", "usage-refreshing"];
        }
        if (c.differentConversation) {
          incoming.run.conversationId = "different-conversation";
        }
        if (c.target) {
          incoming.run.gatewayUiCommandTarget =
            c.target === "removed"
              ? undefined
              : c.target === "foreign"
                ? uiTarget("other-destination", "different-destination-owner")
                : uiTarget("new-connection");
        }
        if (c.profile === "pin" || c.profile === "auto") {
          incoming.run.authProfileId = "synthetic-profile-b";
        }
        if (c.mismatch === "tools") {
          incoming.run.config = { ...cfg, tools: { deny: ["exec"] } };
        }
        if (c.mismatch === "model") {
          incoming.run.model = "another-model";
        }
        if (c.mismatch === "exec") {
          incoming.run.config = { ...cfg, tools: { exec: { security: "deny" } } };
        }
        if (c.mismatch === "workspace") {
          incoming.run.workspaceDir = `${state.workspaceDir}/other`;
        }
        if (c.mismatch === "profile" || c.mismatch === "scopes") {
          incoming.operatorAuthority = createAdmittedRunOperatorAuthority({
            ...operatorAuthority,
            ...(c.mismatch === "profile"
              ? { profileId: "another-owner" }
              : { scopes: ["operator.read"] }),
          });
        }
        let currentEntry = entry;
        if (c.profile === "legacy-pin" || c.profile === "legacy-auto") {
          currentEntry = {
            ...entry,
            authProfileOverride: "synthetic-legacy-profile",
            authProfileOverrideCompactionCount: c.profile === "legacy-auto" ? 0 : undefined,
          };
        }
        if (c.mismatch === "elevation") {
          currentEntry = { ...entry, elevatedLevel: "full" };
        }
        if (c.mismatch === "cwd") {
          currentEntry = { ...entry, spawnedCwd: `${state.workspaceDir}/other` };
        }
        const incomingShape = structuredClone([
          incoming.run.clientCaps,
          incoming.run.gatewayUiCommandTarget,
        ]);
        const assertFrozen = () => {
          expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
          expect([
            run.run.clientCaps,
            run.run.gatewayUiCommandTarget,
            operation.personalToolParticipants?.resolve()?.gatewayUiCommandTarget,
          ]).toEqual([...original, originalParticipant]);
          expect([incoming.run.clientCaps, incoming.run.gatewayUiCommandTarget]).toEqual(
            incomingShape,
          );
        };
        const {
          traceAuthorized: _trace,
          allowCollaborativeSteering: _collaboration,
          ...caller
        } = toolAuthorityOverlay(incoming);
        if (c.crossSurface) {
          const incomingContext = finalizeInboundContext({
            Provider: incoming.run.messageProvider,
            SenderId: incoming.run.senderId,
            SessionKey: key,
            SenderIsBot: c.linkedBot === "incoming",
          });
          bindRequesterProfile(incomingContext, {
            id:
              c.crossSurface === "shared"
                ? "gateway-owner"
                : c.crossSurface === "initiator"
                  ? "initiator"
                  : c.crossSurface === "different"
                    ? "another-human"
                    : "join-owner",
            displayName: null,
            isCurrent: () => incomingIdentityCurrent,
          });
          Object.assign(
            caller,
            resolveInboundReplyToolAuthorityOverlay({
              ctx: incomingContext,
              sessionEntry: currentEntry,
              operatorAuthority: incoming.operatorAuthority,
              senderIsOwner: incoming.run.senderIsOwner === true,
              toolsAllow: incoming.toolsAllow,
              disableTools: false,
            }),
          );
        }
        if (c.sharedOwner) {
          if (c.sharedOwner.bot) {
            Object.assign(
              caller,
              resolveInboundReplyToolAuthorityOverlay({
                ctx: finalizeInboundContext({
                  Provider: "telegram",
                  OriginatingChannel: "telegram",
                  SenderIsBot: true,
                  SenderId: incoming.run.senderId,
                  SessionKey: key,
                }),
                senderIsOwner: true,
                disableTools: false,
              }),
            );
          } else {
            bindReplyInputChannel(
              caller,
              c.sharedOwner.routedBrowser || c.sharedOwner.direction === "outgoing"
                ? "webchat"
                : "telegram",
            );
          }
          if (c.sharedOwner.direction === "incoming" && c.sharedOwner.channelOwner !== false) {
            bindCommandOwnerAuthority(caller, { isCurrent: () => channelOwnerCurrent });
          }
        }
        const delivery = prepareSteeringDelivery({
          ...address,
          entry: currentEntry,
          assertCurrent: assertSource,
        });
        const joined = await prepareReplyMessageJoin({
          followupRun: incoming,
          operation,
          target,
          assertCurrent: assertSource,
          delivery,
          continuation: {
            kind: "continuation",
            caller,
            config: incoming.run.config,
            selectedRoute: { provider: incoming.run.provider, model: incoming.run.model },
            fallbackAvailability: { kind: "none_configured", source: "inherited" },
            executionSelection: c.sessionOnly
              ? captureReplySessionExecutionSelection({
                  config: cfg,
                  agentId: "main",
                  sessionEntry: currentEntry,
                })
              : captureReplyExecutionSelection({ run: incoming.run, sessionEntry: currentEntry }),
          },
        });
        expect(joined.kind).toBe(outcome === "deferred" ? "deferred" : "prepared");
        if (
          (c.crossSurface === "different" && c.mismatch === "model") ||
          c.sharedOwner?.bot ||
          c.linkedBot
        ) {
          expect(joined).toMatchObject({ kind: "deferred", reason: "requester-mismatch" });
        }
        if (c.crossSurface === "incoming" && c.mismatch === "model") {
          expect(joined).toMatchObject({ kind: "deferred", reason: "model-fallback-changed" });
        }
        assertFrozen();
        if (joined.kind !== "prepared") {
          expect(delivered).not.toHaveBeenCalled();
          return;
        }
        if (c.sharedOwner) {
          expect(joined.allowPendingUserInputAnswer).toBe(false);
        }
        if (c.after === "revoke") {
          sourceRevocation.abort(new Error("Caller revoked"));
        }
        if (c.after === "link-revoke") {
          incomingIdentityCurrent = false;
        }
        if (c.after === "identity-disconnect") {
          originalIdentityCurrent = false;
        }
        if (c.after === "owner-revoke") {
          channelOwnerCurrent = false;
        }
        if (c.after === "shared-revoke") {
          sharedRevocation.abort(new Error("Shared browser authority revoked"));
        }
        if (c.after === "settings" || c.after === "activity") {
          const settings = c.after === "settings";
          const updated = await patchSessionEntryCore(address, () =>
            settings ? { elevatedLevel: "full" } : { updatedAt: 2 },
          );
          expect(updated).toMatchObject({
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            ...(settings ? { elevatedLevel: "full" } : {}),
          });
          if (!settings) {
            expect(updated?.updatedAt).toBeGreaterThan(entry.updatedAt);
          }
        }
        if (c.after === "backend") {
          operation.attachBackend({ ...backend, queueMessage: replacement });
        }
        try {
          if (c.after === "caller-revoke") {
            incomingRevocation.abort(new Error("Incoming caller revoked"));
            assertSource();
            operatorAuthority.assertCurrent();
            await expect(joined.prepareCurrent()).rejects.toThrow("Incoming caller revoked");
            expect(delivered).not.toHaveBeenCalled();
            assertFrozen();
            return;
          }
          if (outcome === "revoked") {
            const refused = await beginReplyMessageInjectionTarget(target, incoming.prompt, {
              assertCurrent: assertSource,
            });
            expect(await refused.acceptance).toBe(false);
            expect(await refused.outcome).toMatchObject({
              status: "failed",
              error: expect.objectContaining({ message: "Caller revoked" }),
            });
            expect(delivered).not.toHaveBeenCalled();
            expect(replacement).not.toHaveBeenCalled();
            return;
          }
          const readAuthority = joined.toolAuthority.read;
          const closed = c.after === "delivery";
          const admission = beginReplyMessageInjectionTarget(target, incoming.prompt, {
            assertCurrent: assertSource,
            isInboundUserMessage: true,
            ...(joined.allowPendingUserInputAnswer === false
              ? { allowPendingUserInputAnswer: false as const }
              : {}),
            terminalReplyExpectation: "required",
            toolAuthorityFingerprint: joined.toolAuthorityFingerprint,
            toolAuthorityPreparation: bindPreparedToolAuthority(
              bindWorkerToolPreparation({
                authorityKind: "source-bound" as const,
                assertCurrent: closed ? assertSource : readAuthority,
                compatAssertCurrent: readAuthority,
                prepareCurrent: closed
                  ? async () => {
                      await joined.prepareCurrent();
                      if (closed) {
                        if (isToolAuthorityReadCaptureActive()) {
                          delivery.release();
                        }
                      } else {
                        await delivery.prepareCurrent();
                      }
                    }
                  : joined.prepareCurrent,
              }),
            ),
          });
          if (c.after === "shared-revoke") {
            await expect(admission).rejects.toThrow("Shared browser authority revoked");
            expect(delivered).not.toHaveBeenCalled();
            expect(replacement).not.toHaveBeenCalled();
            assertFrozen();
            return;
          }
          const attempt = await admission;
          expect((await attempt.outcome).status).toBe(outcome);
          expect(delivered).toHaveBeenCalledTimes(outcome === "accepted" ? 1 : 0);
          expect(replacement).not.toHaveBeenCalled();
          assertFrozen();
        } finally {
          joined.toolAuthority.release();
        }
      });
    });
  },
);
