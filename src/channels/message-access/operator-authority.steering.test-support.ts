import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { prepareInternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage,
} from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import {
  prepareReplyToolAuthority,
  resolveInboundReplyToolAuthorityOverlay,
} from "../../auto-reply/reply/reply-tool-authority.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { withAdminIngress } from "./operator-authority.test-support.js";

export function registerLinkedChannelSteeringTests() {
  it.each(["equivalent", "sessions", "sandbox", "agents", "roles-disabled"] as const)(
    "keeps linked-channel steering requester-bound with %s roles",
    async (difference) => {
      await withAdminIngress(
        async ({ cfg, admins, context, activatePolicy, gateway }) => {
          if (difference !== "roles-disabled") {
            const roles = structuredClone(cfg.gateway!.roles!);
            const otherRole = structuredClone(roles.definitions.admin!);
            if (difference === "sessions") {
              otherRole.sessions.others = "view";
            } else if (difference === "sandbox") {
              otherRole.sandbox = "required";
            } else if (difference === "agents") {
              otherRole.agents = ["main"];
            }
            roles.definitions.steerer = otherRole;
            setUserProfileRole(admins[1]!.profile.id, "steerer");
            await activatePolicy({ roles });
          }
          const overlays = [];
          for (const { identity } of [admins[0]!, admins[1]!, admins[0]!]) {
            const ctx = await context(identity.senderId);
            const operatorAuthority = expectDefined(
              prepareInternalGetReplyOptions(undefined, ctx)?.operatorAuthority,
              "linked-channel operator authority",
            );
            overlays.push(
              resolveInboundReplyToolAuthorityOverlay({
                ctx,
                operatorAuthority,
                senderIsOwner: true,
                disableTools: false,
              }),
            );
          }
          const owner = expectDefined(overlays[0], "owner overlay");
          const steerer = expectDefined(overlays[1], "steerer overlay");
          const reconnect = expectDefined(overlays[2], "same-requester reconnect overlay");
          expect(owner.operatorAuthority!.scopes).toEqual(steerer.operatorAuthority!.scopes);
          expect(owner.operatorAuthority!.gatewayAccessGrant).toBeNull();
          expect(steerer.operatorAuthority!.gatewayAccessGrant).toBeNull();
          const uiCapture = expectDefined(
            await captureGatewayOperatorRunAuthority({
              client: createOperatorClient({
                profileId: admins[0]!.profile.id,
                scopes: [...owner.operatorAuthority!.scopes],
              }),
              context: gateway,
              sourceAuthority: null,
            }),
            "Control UI operator authority",
          );
          const run = createQueueTestRun({ prompt: "Owner's channel request" });
          const { operatorAuthority, originatingChannel, toolsAllow, disableTools, ...runOverlay } =
            owner;
          Object.assign(run, { operatorAuthority, originatingChannel, toolsAllow, disableTools });
          Object.assign(run.run, runOverlay, { config: cfg, agentId: "main" });
          const operation = createTestReplyOperation({ sessionId: run.run.sessionId });
          try {
            await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
            await operation.bindToolAuthorityRouteAsync(run.run);
            const queueMessage = vi.fn(async () => {});
            operation.attachBackend({ kind: "embedded", cancel: vi.fn(), queueMessage });
            operation.setPhase("running");
            const equivalent = difference === "equivalent" || difference === "roles-disabled";
            if (equivalent) {
              expect(owner.operatorAuthority!.rolePolicy).toEqual(
                steerer.operatorAuthority!.rolePolicy,
              );
            } else {
              expect(owner.operatorAuthority!.rolePolicy).not.toEqual(
                steerer.operatorAuthority!.rolePolicy,
              );
            }
            await expect(
              queueCurrentReplyRunMessage(run.run.sessionId, "Steering from another linked user", {
                isInboundUserMessage: true,
                toolAuthorityOverlay: steerer,
              }),
            ).resolves.toEqual({ status: "rejected", reason: "tool_authority_mismatch" });
            expect(queueMessage).not.toHaveBeenCalled();
            await expect(
              queueCurrentReplyRunMessage(run.run.sessionId, "Steering after reconnect", {
                isInboundUserMessage: true,
                toolAuthorityOverlay: reconnect,
              }),
            ).resolves.toEqual({ status: "accepted" });
            expect(queueMessage).toHaveBeenCalledOnce();
            expect(owner.operatorAuthority!.rolePolicy).toEqual(uiCapture.authority.rolePolicy);
            if (difference === "roles-disabled") {
              expect(owner.operatorAuthority!.rolePolicy).toBeUndefined();
              expect(steerer.operatorAuthority!.rolePolicy).toBeUndefined();
            }
          } finally {
            operation.complete();
            uiCapture.release();
          }
        },
        difference === "roles-disabled" ? "identity-grant" : "role",
      );
    },
  );
}
