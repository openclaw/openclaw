import { assert, expect, it, vi } from "vitest";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { createAccountScopedConversationBindingManagerV2 } from "../../infra/outbound/account-scoped-conversation-bindings.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { registerPluginCommand } from "../../plugins/commands.js";
import { createPluginCommandRuntime } from "../../plugins/plugin-command-runtime.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { changeCanonicalUserChannelIdentity } from "../../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withDiscordNativeAdminFixture } from "./discord-native-owner.test-support.js";
import { configureNativeAcp, installNativeAcpRuntime } from "./native-acp-owner.test-support.js";

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
    expect(authorize()).toMatchObject({ senderIsOwner: true, isAuthorizedSender: true });
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
      const handler = async () => ({ text: "owner-ok" });
      const name = "ownerprobe";
      registerPluginCommand(name, { name, description: "Owner", handler });
      const candidate = createPluginCommandRuntime()
        .listNativeCandidates("discord")
        .find((entry) => entry.name === name)!;
      const selected = candidate.prepareDispatch();
      if (selected.kind !== "plugin") {
        throw new Error("Expected a plugin dispatch");
      }
      const execute = vi.fn(selected.execute.bind(selected));
      const command = { ...candidate, prepareDispatch: () => ({ ...selected, execute }) };
      const interaction = await run({ pluginCommand: command });
      const observed = execute.mock.calls[0]?.[0];
      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: "owner-ok" }),
      );
      expect(observed).toMatchObject({
        isAuthorizedSender: true,
        senderIsOwner: role !== "allowlisted non-owner",
      });
      if (role === "allowlisted non-owner") {
        expect(observed).not.toHaveProperty("assertOwnerCurrent");
        expect(observed?.assertAuthorizedCurrent).toBeTypeOf("function");
        observed?.assertAuthorizedCurrent?.();
        await changeCanonicalUserChannelIdentity("unlink", profile.id, {
          channelId: "discord",
          accountId: "default",
          senderId: user,
        });
        expect(observed?.assertAuthorizedCurrent).toThrow("requester identity changed");
        console.info(
          "AUTHORITY_CHAIN " +
            JSON.stringify({
              entry: "native-discord",
              principal: "allowlisted-non-owner",
              gatewayOwner: observed?.senderIsOwner,
              callbackEntries: execute.mock.calls.length,
              initialAssertion: "allowed",
              afterIdentityUnlink: "refused",
            }),
        );
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
      expect(execute).toHaveBeenCalledOnce();
    }),
);

it.each(["allowed", "unlinked", "reassigned"] as const)(
  "retains the original non-owner through awaited command preparation: %s",
  async (scenario) => {
    const preparing = createDeferredCore();
    const resume = createDeferredCore();
    let preparationCalls = 0;
    await withDiscordNativeAdminFixture(
      async ({ cfg, state, profile, publishConfig, run, dispatch }) => {
        cfg.commands!.allowFrom = { discord: ["user:" + user] };
        setUserProfileRole(profile.id, "member");
        const other = ensureProfileForEmail("other-member@example.test");
        setUserProfileRole(other.id, "member");
        cfg.agents = { entries: { main: {} } };
        await state.writeConfig(cfg);
        publishConfig();
        const pluginId = "native-binding-preparation-proof";
        const pluginRoot = state.path(pluginId);
        const sessionKey = "agent:main:discord:channel:234567890123456789";
        const conversation = {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:234567890123456789",
        };
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: "native-binding-proof",
            lifecycleRevision: "original",
            updatedAt: Date.now(),
          },
        );
        // Native command admission uses Discord policy; persistence uses the supported
        // core/native account binding owner, not a platform adapter snapshot.
        const manager = createAccountScopedConversationBindingManagerV2({
          channel: "discord",
          accountId: "default",
          cfg,
          stateKey: Symbol("native-preparation-proof"),
          toStoredTargetKind: (kind) => kind,
          toSessionBindingTargetKind: (kind) => kind,
        });
        using _ = { [Symbol.dispose]: () => manager.stop() };
        await getSessionBindingService().bind({
          conversation,
          targetSessionKey: sessionKey,
          targetKind: "session",
          metadata: { pluginBindingOwner: "plugin", pluginId, pluginRoot },
        });
        const effects = createPluginStateKeyedStore<number>(pluginId, {
          namespace: "proof",
          maxEntries: 10,
          env: state.env,
        });
        await effects.register("moves", 0);
        requireActivePluginRegistry().plugins.push(
          createPluginRecord({ id: pluginId, rootDir: pluginRoot }),
        );
        let callbackEntries = 0;
        const name = "bindingprep";
        expect(
          registerPluginCommand(
            pluginId,
            {
              name,
              description: "Native binding preparation proof",
              requireAuth: true,
              async handler(ctx) {
                callbackEntries++;
                expect(ctx.assertOwnerCurrent).toBeUndefined();
                expect(ctx.sessionKey).toBe(sessionKey);
                assert(ctx.withCurrentConversationBinding);
                return ctx.withCurrentConversationBinding(async (authority) => {
                  const action = effects.withCurrent(authority);
                  const observed = await action.observe("moves");
                  await action.compareAndApply("moves", observed.comparison, {
                    operation: "update",
                    action: "set",
                    value: 1,
                  });
                  return { text: "native proof write committed" };
                });
              },
            },
            { pluginRoot },
          ),
        ).toEqual({ ok: true });
        const candidate = createPluginCommandRuntime()
          .listNativeCandidates("discord")
          .find((entry) => entry.name === name);
        assert(candidate);
        const pending = run({ pluginCommand: candidate });
        try {
          expect(
            await Promise.race([
              preparing.promise.then(() => "preparing"),
              pending.then(() => "finished"),
            ]),
          ).toBe("preparing");
          const identity = { channelId: "discord", accountId: "default", senderId: user };
          if (scenario !== "allowed") {
            await changeCanonicalUserChannelIdentity("unlink", profile.id, identity);
            if (scenario === "reassigned") {
              await changeCanonicalUserChannelIdentity("link", other.id, identity);
            }
          }
          resume.resolve();
          const interaction = await pending;
          const persistedMoves = await effects.lookup("moves");
          console.info(
            "AUTHORITY_CHAIN " +
              JSON.stringify({
                entry: "native-discord/command-preparation/V2-state",
                scenario,
                preparationPaused: true,
                callbackEntries,
                persistedMoves,
              }),
          );
          expect(persistedMoves).toBe(scenario === "allowed" ? 1 : 0);
          expect(callbackEntries).toBe(scenario === "allowed" ? 1 : 0);
          expect(interaction.followUp).toHaveBeenCalledWith(
            scenario === "allowed"
              ? expect.objectContaining({ content: "native proof write committed" })
              : unauthorized,
          );
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          resume.resolve();
          await pending;
        }
      },
      {
        // Top-level routing has no remote thread state; do not install the disabled
        // Discord adapter over the native account owner used for this proof.
        threadBindings: { getByThreadId: () => undefined },
        beforeResolveAllowFrom: async () => {
          preparationCalls++;
          preparing.resolve();
          await resume.promise;
        },
      },
    );
    expect(preparationCalls).toBeGreaterThan(0);
  },
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
] as const)("fences /$commandName ACP $label", ({ commandName, preparation }) =>
  withDiscordNativeAdminFixture(
    async ({ cfg, state, profile, publishConfig, run, dispatch, autocomplete }) => {
      const { backendId, target, spec, seed } = configureNativeAcp(
        cfg,
        state,
        "discord",
        publishConfig,
      );
      const { manager, close, effects, preparing, finish, pause } = installNativeAcpRuntime(
        backendId,
        preparation === "revoke" ? "capability" : preparation === "settle" ? "control" : undefined,
        true,
      );
      try {
        if (preparation !== "initialize") {
          await seed({
            ...(preparation === "replace" ? { cwd: state.root } : { model: "fixture/previous" }),
            ...(preparation === "settle" ? { thinking: "off" } : {}),
          });
        }
        effects.length = 0;
        const before = manager.resolveSession(target);
        const expectUnchanged = () =>
          expect([effects, manager.resolveSession(target)]).toEqual([[], before]);
        const expectDenied = (interaction: Awaited<ReturnType<typeof run>>) => {
          expect(interaction.followUp).toHaveBeenCalledWith(unauthorized);
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
          expect((await autocomplete()).respond).toHaveBeenCalledWith([]);
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
        await close();
      }
    },
  ),
);
