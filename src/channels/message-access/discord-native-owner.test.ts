import { expect, it, vi } from "vitest";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import { ensureConfiguredAcpBindingSession } from "../../acp/persistent-bindings.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { registerPluginCommand } from "../../plugins/commands.js";
import {
  createPluginCommandRuntime,
  type PluginCommandDispatchContext,
} from "../../plugins/plugin-command-runtime.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { withDiscordNativeAdminFixture } from "./discord-native-owner.test-support.js";
import { configureNativeAcp, createNativeAcpRuntime } from "./native-acp-owner.test-support.js";

const user = "123456789012345678";
const denied = "You are not authorized to use this command.";
const unauthorized = { content: denied, ephemeral: true };

it("carries current Team-admin authority through registered slash commands without bypassing admission", () =>
  withDiscordNativeAdminFixture(async ({ cfg, profile, publishConfig, run, dispatch }) => {
    publishConfig();
    const expectDenied = async () => {
      expect((await run()).followUp).toHaveBeenCalledWith(unauthorized);
      expect(dispatch).not.toHaveBeenCalled();
    };
    await run();
    expect(dispatch).toHaveBeenCalledOnce();
    const ctx = dispatch.mock.calls[0]![0].ctx;
    const authorize = () => resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true });
    expect(authorize()).toMatchObject({
      senderIsOwner: true,
      isAuthorizedSender: true,
    });
    cfg.commands!.allowFrom = { discord: [] };
    publishConfig();
    await expectDenied();
    delete cfg.commands!.allowFrom;
    publishConfig();
    setUserProfileRole(profile.id, "member");
    await expectDenied();
    expect(authorize().senderIsOwner).toBe(false);
  }));

it.each(["linked owner", "configured owner", "allowlisted non-owner"])(
  "passes only live owner capabilities through native plugin dispatch: %s",
  (role) =>
    withDiscordNativeAdminFixture(async ({ cfg, profile, publishConfig, run }) => {
      const commands = (cfg.commands ??= {});
      commands.allowFrom = { discord: [`user:${user}`] };
      if (role !== "linked owner") {
        setUserProfileRole(profile.id, "member");
      }
      if (role === "configured owner") {
        commands.ownerAllowFrom = [`discord:${user}`];
      }
      publishConfig();
      const handler = vi.fn(async () => ({ text: "owner-ok" }));
      const name = "ownerprobe";
      registerPluginCommand(name, { name, description: "Owner", handler });
      const candidate = createPluginCommandRuntime()
        .listNativeCandidates("discord")
        .find((entry) => entry.name === name)!;
      const selected = candidate.prepareDispatch();
      if (selected.kind !== "plugin") {
        throw new Error("Expected a plugin dispatch");
      }
      const execute = vi.fn((ctx: PluginCommandDispatchContext) => selected.execute(ctx));
      const command = { ...candidate, prepareDispatch: () => ({ ...selected, execute }) };
      const interaction = await run({ pluginCommand: command });
      expect(execute).toHaveBeenCalledOnce();
      const observed = execute.mock.calls[0]?.[0];
      expect(handler).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: "owner-ok" }),
      );
      expect(observed).toMatchObject({
        isAuthorizedSender: true,
        senderIsOwner: role !== "allowlisted non-owner",
      });
      if (role === "allowlisted non-owner") {
        expect(observed).not.toHaveProperty("assertOwnerCurrent");
      } else {
        expect(observed?.assertOwnerCurrent).toBeTypeOf("function");
        observed?.assertOwnerCurrent?.();
        if (role === "linked owner") {
          setUserProfileRole(profile.id, "member");
        } else {
          commands.ownerAllowFrom = ["discord:999999999999999999"];
          publishConfig();
        }
        expect(observed?.assertOwnerCurrent).toThrow("authority changed");
      }
      commands.allowFrom = { discord: [] };
      publishConfig();
      expect((await run({ pluginCommand: command })).followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: denied }),
      );
      expect(handler).toHaveBeenCalledOnce();
    }),
);

it.each([
  { commandName: "think", preparation: "initialize", label: "initialization" },
  { commandName: "think", preparation: "configure", label: "configuration" },
  { commandName: "think", preparation: "replace", label: "replacement" },
  { commandName: "new", preparation: "initialize", label: "recovery initialization" },
  { commandName: "status", preparation: "initialize", label: "read without initialization" },
  { commandName: "status", preparation: "replace", label: "read without replacement" },
  { commandName: "think", preparation: "revoke", label: "revocation during capability lookup" },
  { commandName: "think", preparation: "settle", label: "revocation during accepted control" },
] as const)("fences /$commandName ACP $label", async ({ commandName, preparation }) => {
  await withDiscordNativeAdminFixture(
    async ({ cfg, state, profile, publishConfig, run, dispatch, autocomplete }) => {
      const { backendId, binding, spec } = configureNativeAcp(cfg, state, "discord", publishConfig);
      const { runtime, effects, preparing, finish, pause } = createNativeAcpRuntime(
        backendId,
        preparation === "revoke" ? "capability" : preparation === "settle" ? "control" : undefined,
        true,
      );
      managerTesting.resetAcpSessionManagerForTests();
      registerAcpRuntimeBackend({ id: backendId, runtime });
      const manager = getAcpSessionManager();
      try {
        if (preparation !== "initialize") {
          const existing = {
            ...spec,
            ...(preparation === "replace" ? { cwd: state.root } : { model: "fixture/previous" }),
            ...(preparation === "settle" ? { thinking: "off" } : {}),
          };
          expect(await ensureConfiguredAcpBindingSession({ cfg, spec: existing })).toMatchObject({
            ok: true,
          });
        }
        effects.length = 0;
        const target = { cfg, agentId: "main", sessionKey: binding.statefulTarget.sessionKey };
        const before = manager.resolveSession(target);
        const expectUnchanged = () =>
          expect([effects, manager.resolveSession(target)]).toEqual([[], before]);
        const expectDenied = (interaction: Awaited<ReturnType<typeof run>>) => {
          expect(interaction.followUp).toHaveBeenCalledWith({
            content: "You are not authorized to use this command.",
            ephemeral: true,
          });
          expect(dispatch).not.toHaveBeenCalled();
        };
        const command = { commandName, argument: commandName === "think" ? "high" : undefined };
        if (
          commandName === "think" &&
          ["initialize", "configure", "replace"].includes(preparation)
        ) {
          const completed = await autocomplete();
          expect(completed.respond).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ value: "high" })]),
          );
          expectUnchanged();
          setUserProfileRole(profile.id, "member");
          const revoked = await autocomplete();
          expect(revoked.respond).toHaveBeenCalledWith([]);
          expectUnchanged();
          setUserProfileRole(profile.id, "admin");
        }
        const deniedInteraction = await run({ ...command, senderId: "100000000000000009" });
        if (commandName === "status") {
          let lastUpdatedAt: number | undefined;
          const expectStatus = async (interaction: Awaited<ReturnType<typeof run>>) => {
            expect(interaction.followUp).toHaveBeenCalledWith(
              expect.objectContaining({ content: expect.stringContaining("Session:") }),
            );
            expect(effects).toEqual([]);
            const after = manager.resolveSession(target);
            const previous = before.kind === "ready" && before.entry;
            const current = after.kind === "ready" && after.entry;
            if (!previous || !current) {
              expect(after).toEqual(before);
              return;
            }
            // Delivered /status replies are transcript activity, not ACP ownership changes.
            expect({
              ...after,
              entry: { ...current, updatedAt: previous.updatedAt },
            }).toEqual(before);
            expect(current.updatedAt).toBeGreaterThanOrEqual(lastUpdatedAt ?? previous.updatedAt);
            lastUpdatedAt = current.updatedAt;
          };
          await expectStatus(deniedInteraction);
          await expectStatus(await run(command));
          expect(dispatch).not.toHaveBeenCalled();
          return;
        }
        expectDenied(deniedInteraction);
        expectUnchanged();
        pause();
        const allowedRun = run(command);
        if (preparation === "revoke" || preparation === "settle") {
          await preparing.promise;
          setUserProfileRole(profile.id, "member");
          finish.resolve();
          expectDenied(await allowedRun);
          const after = manager.resolveSession(target);
          if (preparation === "revoke") {
            expectUnchanged();
          } else {
            expect(effects).toEqual(["configure:model"]);
            expect(after).toMatchObject({
              kind: "ready",
              meta: { runtimeOptions: { model: spec.model, thinking: "off" } },
            });
          }
          return;
        }
        await allowedRun;
        expect(dispatch).toHaveBeenCalledOnce();
        expect(effects).toEqual(
          preparation === "configure"
            ? ["configure:model"]
            : preparation === "replace"
              ? ["close", "initialize"]
              : ["initialize"],
        );
        const after = manager.resolveSession(target);
        expect(after).toMatchObject({
          kind: "ready",
          meta: { runtimeOptions: { model: spec.model, cwd: state.workspaceDir } },
        });
      } finally {
        finish.resolve();
        await disposeAcpSessionManagerInstance(manager, "test complete");
        unregisterAcpRuntimeBackend(backendId);
        managerTesting.resetAcpSessionManagerForTests();
      }
    },
  );
});
