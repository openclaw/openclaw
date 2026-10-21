import { expect, it, vi } from "vitest";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { registerPluginCommand } from "../../plugins/commands.js";
import {
  createPluginCommandRuntime,
  type PluginCommandDispatchContext,
} from "../../plugins/plugin-command-runtime.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { withDiscordNativeAdminFixture } from "./discord-native-owner.test-support.js";

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
      const registered = registerPluginCommand(name, { name, description: "Owner", handler });
      expect(registered).toEqual({ ok: true });
      const candidate = createPluginCommandRuntime()
        .listNativeCandidates("discord")
        .find((entry) => entry.name === name)!;
      expect(candidate).toBeDefined();
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
