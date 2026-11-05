import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it("transfers recovered channel policy past occurrence expiry but not identity revocation", () =>
  withAdminIngress(async ({ admins, context, gateway, retire }) => {
    const member = expectDefined(admins[0], "linked member");
    setUserProfileRole(member.profile.id, "member");
    const turn = await context(member.identity.senderId);
    const original = expectDefined(
      prepareInternalGetReplyOptions(undefined, turn)?.operatorAuthority,
      "original channel policy",
    );
    const source = captureQueuedOperatorRecoverySource(original);
    retire();
    let workCurrent = true;
    const restored = await restoreGatewayQueuedOperatorRecovery({
      source,
      context: gateway,
      assertCurrent: () => {
        if (!workCurrent) {
          throw new Error("occurrence expired");
        }
      },
    });
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
      operatorRunAuthority: restored.authority,
      scopes: [...restored.authority.scopes],
    });
    const continuation = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context: gateway,
        independentContinuation: true,
      }),
      "accepted independent continuation",
    );
    try {
      expect(continuation.authority.profileId).toBe(member.profile.id);
      expect(continuation.authority.scopes).toEqual(["operator.read", "operator.write"]);
      workCurrent = false;
      expect(restored.authority.assertCurrent).toThrow("occurrence expired");
      restored.release();
      expect(continuation.authority.assertCurrent).not.toThrow();
      await changeCanonicalUserChannelIdentity("unlink", member.profile.id, member.identity);
      expect(continuation.authority.signal?.aborted).toBe(true);
      expect(continuation.authority.assertCurrent).toThrow();
    } finally {
      continuation.release();
      restored.release();
    }
  }));
