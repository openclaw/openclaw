import { appendFile, readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { getAcpSessionManager, testing } from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { installDiscordRegistryHooks } from "../test-helpers/command-auth-registry-fixture.js";
import { handleAcpCommand } from "./commands-acp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

installDiscordRegistryHooks();

it.each([
  [false, "101", "none"],
  [false, "ordinary-member", "none"],
  [false, "100", "role"],
  [false, "100", "unlink"],
  [false, "100", "reassign"],
  [false, "100", "accepted"],
  [true, "100", "role"],
  [true, "100", "accepted"],
] as const)(
  "fences ACP setMode=%s sender=%s transition=%s",
  async (setMode, senderId, transition) => {
    const action = setMode ? "set-mode plan" : "permissions auto-approve";
    const effect = setMode ? "mode=plan" : "approval_policy=auto-approve";
    const option = setMode ? "runtimeMode" : "permissionProfile";
    const value = setMode ? "plan" : "auto-approve";
    await withAdminIngress(async ({ cfg, admins, context, state }) => {
      const backendId = "command-owner-proof";
      cfg.acp = { enabled: true, backend: backendId, allowedAgents: ["main"] };
      cfg.agents = { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } };
      cfg.session = { store: state.path("command-sessions.json") };
      setRuntimeConfigSnapshot(cfg, cfg);

      const effectsPath = state.path("acp-command-effects.log");
      const boundaryReached = createDeferredCore();
      const releaseBoundary = createDeferredCore();
      let commandStarted = false;
      const recordControl = async (entry: string) => {
        await appendFile(effectsPath, `${entry}\n`);
        if (transition === "accepted") {
          boundaryReached.resolve();
          await releaseBoundary.promise;
        }
      };
      registerAcpRuntimeBackend({
        id: backendId,
        runtime: {
          ownerAwareSessions: 1,
          async ensureSession(input) {
            await appendFile(effectsPath, "initialize\n");
            return {
              agentId: input.agentId,
              sessionKey: input.sessionKey,
              backend: backendId,
              runtimeSessionName: input.sessionKey,
              backendSessionId: `runtime:${input.sessionKey}`,
            };
          },
          async getCapabilities() {
            if (commandStarted && ["role", "unlink", "reassign"].includes(transition)) {
              boundaryReached.resolve();
              await releaseBoundary.promise;
            }
            return {
              controls: ["session/set_config_option", "session/set_mode"],
              configOptionKeys: ["approval_policy"],
            };
          },
          async setConfigOption({ key, value: wireValue }) {
            await recordControl(`${key}=${wireValue}`);
            return { configOptions: [{ id: key, currentValue: wireValue }] };
          },
          setMode: async ({ mode }) => recordControl(`mode=${mode}`),
          close: async () => appendFile(effectsPath, "close\n"),
          async cancel() {},
          runTurn() {
            throw new Error("An ACP options command must not start a provider turn");
          },
        },
      });
      testing.resetAcpSessionManagerForTests();
      const manager = getAcpSessionManager();
      let commandRun: ReturnType<typeof handleAcpCommand> | undefined;
      try {
        const ctx = await context(senderId);
        const params = buildCommandTestParams(`/acp ${action}`, cfg, ctx, {
          workspaceDir: state.workspaceDir,
        });
        params.sessionKey = ctx.SessionKey;
        const target = { cfg, sessionKey: params.sessionKey, agentId: params.agentId };
        await manager.initializeSession({ ...target, agent: "main", mode: "persistent" });
        await writeFile(effectsPath, "");
        const before = manager.resolveSession(target);

        commandStarted = true;
        commandRun = handleAcpCommand(params, true);
        if (transition !== "none") {
          await awaitGateBeforeSettlement(
            boundaryReached.promise,
            commandRun,
            "Command finished before authority boundary",
          );
          const admin = admins[0]!;
          if (transition === "role" || transition === "accepted") {
            setUserProfileRole(admin.profile.id, "member");
          } else {
            unlinkUserChannelIdentity(admin.profile.id, admin.identity);
            if (transition === "reassign") {
              linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
            }
          }
          releaseBoundary.resolve();
        }
        const result = await commandRun;
        const applied =
          senderId !== "ordinary-member" && (transition === "none" || transition === "accepted");
        expect(await readFile(effectsPath, "utf8")).toBe(applied ? `${effect}\n` : "");
        const after = manager.resolveSession(target);
        if (applied) {
          expect(result?.reply?.text).toContain("Updated ACP");
          expect(after).toMatchObject({
            kind: "ready",
            meta: { runtimeOptions: { [option]: value } },
          });
        } else {
          expect(after).toEqual(before);
          expect(result?.reply?.text).toContain(
            senderId === "ordinary-member" ? "owner-only command" : "authority changed",
          );
        }
      } finally {
        releaseBoundary.resolve();
        await commandRun;
        await disposeAcpSessionManagerInstance(manager, "test complete");
        unregisterAcpRuntimeBackend(backendId);
        testing.resetAcpSessionManagerForTests();
      }
    });
  },
);
