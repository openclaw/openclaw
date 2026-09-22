import { appendFile, readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
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
import { setUserProfileRole } from "../../state/user-profiles.js";
import { installDiscordRegistryHooks } from "../test-helpers/command-auth-registry-fixture.js";
import { handleAcpCommand } from "./commands-acp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

installDiscordRegistryHooks();

const principals = [
  { principal: "first-admin", senderId: "100", transition: "none" },
  { principal: "second-admin", senderId: "101", transition: "none" },
  { principal: "channel-member", senderId: "ordinary-member", transition: "none" },
  { principal: "demoted-admin", senderId: "100", transition: "role" },
  { principal: "unlinked-admin", senderId: "100", transition: "unlink" },
  { principal: "reassigned-admin", senderId: "100", transition: "reassign" },
  { principal: "admin-with-accepted-write", senderId: "100", transition: "accepted" },
] as const;

it.each(
  [
    {
      action: "permissions auto-approve",
      effect: "approval_policy=auto-approve",
      option: "permissionProfile",
      value: "auto-approve",
    },
    { action: "set-mode plan", effect: "mode=plan", option: "runtimeMode", value: "plan" },
  ].flatMap((action) => principals.map((principal) => Object.assign({}, action, principal))),
)(
  "fences the real /acp $action effect for $principal",
  async ({ action, effect, option, value, principal, senderId, transition }) => {
    await withAdminIngress(async ({ cfg, admins, context, state }) => {
      const backendId = "command-owner-proof";
      cfg.acp = { enabled: true, backend: backendId, allowedAgents: ["main"] };
      cfg.agents = {
        ownership: "explicit",
        entries: { main: { workspace: state.workspaceDir } },
      };
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
          async setMode({ mode }) {
            await recordControl(`mode=${mode}`);
          },
          async close() {
            await appendFile(effectsPath, "close\n");
          },
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
          expect(
            await Promise.race([
              boundaryReached.promise.then(() => "boundary"),
              commandRun.then(() => "finished"),
            ]),
          ).toBe("boundary");
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
          principal !== "channel-member" && (transition === "none" || transition === "accepted");
        expect(await readFile(effectsPath, "utf8")).toBe(applied ? `${effect}\n` : "");
        const after = manager.resolveSession(target);
        if (applied) {
          expect(result?.reply?.text).toContain("Updated ACP");
          expect(after.kind).toBe("ready");
          if (after.kind === "ready") {
            expect(after.meta.runtimeOptions).toMatchObject({ [option]: value });
          }
        } else {
          expect(after).toEqual(before);
          expect(result?.reply?.text).toContain(
            principal === "channel-member" ? "owner-only command" : "authority changed",
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
