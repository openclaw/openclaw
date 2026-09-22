import { expect, it, vi } from "vitest";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { registerPluginCommand } from "../../plugins/commands.js";
import {
  createPluginCommandRuntime,
  type PluginCommandDispatchContext,
} from "../../plugins/plugin-command-runtime.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { withDiscordNativeAdminFixture } from "./discord-native-owner.test-support.js";

it("carries current Team-admin authority through registered slash commands without bypassing admission", async () => {
  await withDiscordNativeAdminFixture(async ({ cfg, profile, publishConfig, run, dispatch }) => {
    publishConfig();
    const expectDenied = async () => {
      expect((await run()).followUp).toHaveBeenCalledWith({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      });
      expect(dispatch).not.toHaveBeenCalled();
    };
    await run();
    expect(dispatch).toHaveBeenCalledOnce();
    const ctx = dispatch.mock.calls[0]![0].ctx;
    expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true })).toMatchObject({
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
    expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true }).senderIsOwner).toBe(
      false,
    );
  });
});

it.each(["linked owner", "configured owner", "allowlisted non-owner"])(
  "passes only live owner capabilities through native plugin dispatch: %s",
  async (role) => {
    await withDiscordNativeAdminFixture(async ({ cfg, profile, publishConfig, run }) => {
      cfg.commands = { ...cfg.commands, allowFrom: { discord: ["user:123456789012345678"] } };
      if (role !== "linked owner") {
        setUserProfileRole(profile.id, "member");
      }
      if (role === "configured owner") {
        cfg.commands.ownerAllowFrom = ["discord:123456789012345678"];
      }
      publishConfig();
      const handler = vi.fn(async () => ({ text: "PLUGIN-OWNER-CAPABILITY-OK" }));
      expect(
        registerPluginCommand("native-owner-probe", {
          name: "ownerprobe",
          description: "Native owner capability probe",
          handler,
        }),
      ).toEqual({ ok: true });
      const candidate = createPluginCommandRuntime()
        .listNativeCandidates("discord")
        .find((entry) => entry.name === "ownerprobe");
      if (!candidate) {
        throw new Error("Expected native owner probe registration");
      }
      const observedContexts: PluginCommandDispatchContext[] = [];
      const command = {
        ...candidate,
        prepareDispatch: (args?: string) => {
          const selected = candidate.prepareDispatch(args);
          return selected.kind === "non-plugin"
            ? selected
            : {
                ...selected,
                execute: async (ctx: PluginCommandDispatchContext) => {
                  observedContexts.push(ctx);
                  return selected.execute(ctx);
                },
              };
        },
      };
      const interaction = await run({ pluginCommand: command });
      expect(observedContexts).toHaveLength(1);
      const observed = observedContexts[0];
      expect(handler).toHaveBeenCalledOnce();
      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: "PLUGIN-OWNER-CAPABILITY-OK" }),
      );
      expect(observed?.isAuthorizedSender).toBe(true);
      if (role === "allowlisted non-owner") {
        expect(observed?.senderIsOwner).toBe(false);
        expect(observed).not.toHaveProperty("assertOwnerCurrent");
      } else {
        expect(observed?.senderIsOwner).toBe(true);
        expect(observed?.assertOwnerCurrent).toBeTypeOf("function");
        observed?.assertOwnerCurrent?.();
        if (role === "linked owner") {
          setUserProfileRole(profile.id, "member");
        } else {
          cfg.commands.ownerAllowFrom = ["discord:999999999999999999"];
          publishConfig();
        }
        expect(observed?.assertOwnerCurrent).toThrow("authority changed");
      }
      cfg.commands.allowFrom = { discord: [] };
      publishConfig();
      expect((await run({ pluginCommand: command })).followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: "You are not authorized to use this command." }),
      );
      expect(handler).toHaveBeenCalledOnce();
    });
  },
);
