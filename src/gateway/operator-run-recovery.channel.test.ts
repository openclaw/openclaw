import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";

it.each(["unlink", "reassign"] as const)(
  "refuses persisted channel member recovery after %s",
  (change) =>
    withAdminIngress(async ({ admins, context, gateway, retire, state }) => {
      const member = expectDefined(admins[0], "linked member");
      setUserProfileRole(member.profile.id, "member");
      const turn = await context(member.identity.senderId);
      expect(getCommandOwnerAuthority(turn)?.operatorAuthority).toBeUndefined();
      const original = expectDefined(
        prepareInternalGetReplyOptions(undefined, turn)?.operatorAuthority,
        "verified channel member authority",
      );
      const queuedPath = path.join(state.stateDir, "queued-member.json");
      await writeFile(queuedPath, JSON.stringify(captureQueuedOperatorRecoverySource(original)));
      retire();
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
      const source = decodeQueuedOperatorRecoverySource(
        JSON.parse(await readFile(queuedPath, "utf8")),
      );
      const restore = () =>
        restoreGatewayQueuedOperatorRecovery({
          source,
          context: gateway,
          assertCurrent: () => {},
        });
      const restored = await restore();
      try {
        expect(restored.authority).toMatchObject({
          profileId: member.profile.id,
          scopes: ["operator.read", "operator.write"],
        });
        await changeCanonicalUserChannelIdentity("unlink", member.profile.id, member.identity);
        if (change === "reassign") {
          const other = expectDefined(admins[1], "replacement owner");
          await changeCanonicalUserChannelIdentity("link", other.profile.id, member.identity);
        }
        await expect(restore()).rejects.toThrow();
      } finally {
        restored.release();
      }
    }),
);
