import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { readPersistedFileStat } from "../agents/sessions/tools/file-write-verification.js";
import { createWriteTool } from "../agents/sessions/tools/write.js";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { prepareChannelRunAdmission } from "../auto-reply/reply/channel-run-admission.js";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import { isMissingPathError } from "../infra/errors.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";

it.each(["unlink", "reassign"] as const)(
  "recovers a persisted channel member and fences final I/O after %s",
  (change) =>
    withAdminIngress(async ({ admins, context, gateway, retire, cfg, state }) => {
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
      const admission = prepareChannelRunAdmission({
        cfg,
        runId: "queued-member-effect",
        agentId: "main",
        ingressKind: "channel",
        boundary: "discord",
        operatorAuthority: restored.authority,
      });
      const beforeWrite = createDeferredCore();
      const releaseWrite = createDeferredCore();
      let pauseWrite = false;
      let writes = 0;
      let pendingWrite: Promise<unknown> | undefined;
      let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
      try {
        expect(restored.authority).toMatchObject({
          profileId: member.profile.id,
          scopes: ["operator.read", "operator.write"],
        });
        expect(restored.controlUiAdmin).toBe(false);
        const admittedRunContext = await admission.admit("plugin-harness", "queued-member");
        bindGatewayContextResolver(admittedRunContext, () => gateway);
        host = createAgentHarnessHostCapabilities({
          attempt: {
            runId: "queued-member-effect",
            agentId: "main",
            sessionKey: turn.SessionKey!,
            sessionId: "queued-member-session",
            admittedRunContext,
          },
          pluginId: "codex",
        });
        const tool = expectDefined(
          host.capabilities.bindToolSurface([
            createWriteTool(state.stateDir, {
              operations: {
                mkdir: async (dir) => {
                  await mkdir(dir, { recursive: true });
                  if (pauseWrite) {
                    beforeWrite.resolve();
                    await releaseWrite.promise;
                  }
                },
                readFile,
                statFile: (file) => readPersistedFileStat(file, isMissingPathError),
                writeFile: async (file, content) => {
                  writes += 1;
                  await writeFile(file, content, "utf8");
                },
              },
            }),
          ])[0],
          "recovered member write capability",
        );
        const file = "queued-member-effect.txt";
        await tool.execute("allowed", { path: file, content: "allowed\n" });
        expect(await readFile(path.join(state.stateDir, file), "utf8")).toBe("allowed\n");
        // Hold inside the real tool after admission, then revoke without a caller abort signal.
        pauseWrite = true;
        pendingWrite = tool.execute("revoked", { path: file, content: "forbidden\n" });
        void pendingWrite.catch(beforeWrite.reject);
        await beforeWrite.promise;
        await changeCanonicalUserChannelIdentity("unlink", member.profile.id, member.identity);
        if (change === "reassign") {
          const other = expectDefined(admins[1], "replacement owner");
          await changeCanonicalUserChannelIdentity("link", other.profile.id, member.identity);
        }
        releaseWrite.resolve();
        await expect(pendingWrite).rejects.toThrow("tool invocation authority is no longer active");
        expect(writes).toBe(1);
        expect(await readFile(path.join(state.stateDir, file), "utf8")).toBe("allowed\n");
        await expect(restore()).rejects.toThrow("Queued channel operator authority changed");
      } finally {
        releaseWrite.resolve();
        await pendingWrite?.catch(() => undefined);
        host?.close();
        admission.close();
        restored.release();
      }
    }),
);
