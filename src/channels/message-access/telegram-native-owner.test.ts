import { expect, it, vi } from "vitest";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../../commands/models/auth.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { withTelegramNativeOwners } from "./telegram-native-owner.test-support.js";

it("delivers current linked Team-admin ownership through registered Telegram plugin commands", async () => {
  await withTelegramNativeOwners(async ({ invoke, handler, driver }) => {
    await invoke(100);
    await invoke(200);
    expect(handler).toHaveBeenCalledTimes(2);
    for (const [ctx] of handler.mock.calls) {
      expect(ctx).toMatchObject({
        senderIsOwner: true,
        isAuthorizedSender: true,
        channel: "telegram",
        accountId: "default",
        assertOwnerCurrent: expect.any(Function),
      });
    }
    expect(driver.pairingStoreReadCount()).toBe(0);
    expect(driver.deliveries()).toHaveLength(2);
  });
});

it.each([
  { name: "enabled", groupPolicy: "open", topicPolicy: undefined, allowed: true },
  { name: "group disabled", groupPolicy: "disabled", topicPolicy: undefined, allowed: false },
  { name: "topic disabled", groupPolicy: "open", topicPolicy: "disabled", allowed: false },
  {
    name: "topic overrides disabled group",
    groupPolicy: "disabled",
    topicPolicy: "open",
    allowed: true,
  },
] as const)(
  "preserves real topic routing and room admission for linked native owners: $name",
  async ({ groupPolicy, topicPolicy, allowed }) => {
    await withTelegramNativeOwners(async ({ cfg, invokeTopic, handler, driver }) => {
      cfg.channels!.telegram!.groups = {
        "-10012345": {
          groupPolicy,
          topics: {
            "42": {
              agentId: "topic-owner",
              ...(topicPolicy ? { groupPolicy: topicPolicy } : {}),
            },
          },
        },
      };
      await invokeTopic();
      if (allowed) {
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            senderIsOwner: true,
            agentId: "topic-owner",
            messageThreadId: 42,
            sessionKey: "agent:topic-owner:telegram:group:-10012345:topic:42",
          }),
        );
        expect(driver.deliveries()).toEqual([{ replies: [{ text: "TELEGRAM-OWNER-OK" }] }]);
      } else {
        expect(handler).not.toHaveBeenCalled();
        expect(driver.sentMessages()).toEqual([]);
        expect(driver.deliveries()).toEqual([]);
      }
    });
  },
);

it.each(["provider allowlist", "global allowlist", "unlinked", "asserted"])(
  "keeps native owner commands denied for %s",
  async (denial) => {
    await withTelegramNativeOwners(async ({ cfg, invoke, handler, driver }) => {
      if (denial === "provider allowlist") {
        cfg.commands!.allowFrom = { telegram: ["999999"] };
      }
      if (denial === "global allowlist") {
        cfg.commands!.allowFrom = { "*": ["999999"] };
      }
      await invoke(denial === "unlinked" ? 300 : 100);
      expect(handler).not.toHaveBeenCalled();
      expect(driver.sentMessages()).toEqual([
        {
          chatId: denial === "unlinked" ? 300 : 100,
          text: "You are not authorized to use this command.",
        },
      ]);
      expect(driver.deliveries()).toEqual([]);
    }, denial === "asserted");
  },
);

it.each(["demote", "unlink", "reassign"])(
  "rejects stale native plugin owner authority after %s",
  async (revocation) => {
    await withTelegramNativeOwners(async ({ invoke, handler, admins, driver }) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      let effects = 0;
      handler.mockImplementation(async (ctx) => {
        expect(ctx.senderIsOwner).toBe(true);
        expect(ctx.assertOwnerCurrent).toBeTypeOf("function");
        entered.resolve();
        await finish.promise;
        ctx.assertOwnerCurrent?.();
        effects += 1;
        return { text: "TELEGRAM-OWNER-OK" };
      });
      const pending = invoke();
      try {
        expect(
          await Promise.race([
            entered.promise.then(() => "entered"),
            pending.then(() => "finished"),
          ]),
        ).toBe("entered");
        const admin = admins[0]!;
        if (revocation === "demote") {
          setUserProfileRole(admin.profile.id, "member");
        } else {
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
          if (revocation === "reassign") {
            linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
          }
        }
        finish.resolve();
        await pending;
        expect(effects).toBe(0);
        expect(driver.deliveries()).toHaveLength(1);
        expect(driver.deliveries()).toContainEqual(
          expect.objectContaining({
            replies: [
              expect.objectContaining({ text: "⚠️ Command failed. Please try again later." }),
            ],
          }),
        );
      } finally {
        finish.resolve();
        await pending;
      }
    });
  },
);

it.each([false, true])(
  "retains linked owner authority through native provider login (revoke=%s)",
  async (revoke) => {
    await withTelegramNativeOwners(async ({ cfg, admins, driver }) => {
      cfg.agents = { defaults: { model: "openai/gpt-5.5" } };
      const finish = createDeferredCore();
      const notified = createDeferredCore();
      let writes = 0;
      const loginFlow = vi.fn<
        (options: ModelsAuthLoginFlowOptions) => Promise<ModelsAuthLoginFlowResult>
      >(async (options) => {
        await options.prompter.deviceCode?.({ title: "Sign in", code: "OWNER-TEST-CODE" });
        await finish.promise;
        options.assertCurrent?.();
        writes += 1;
        return {
          providerId: "openai",
          methodId: "device-code",
          authRefresh: "refreshed",
          profiles: [],
        };
      });
      driver.configureLogin({
        run: loginFlow,
        onResult: () => notified.resolve(),
      });
      try {
        await driver.invoke({
          command: "login",
          senderId: 100,
          match: "openai/openai-device-code",
        });
        expect(loginFlow).toHaveBeenCalledOnce();
        if (revoke) {
          setUserProfileRole(admins[0]!.profile.id, "member");
        }
        finish.resolve();
        await notified.promise;
        expect(writes).toBe(revoke ? 0 : 1);
      } finally {
        finish.resolve();
        if (loginFlow.mock.calls.length > 0) {
          await notified.promise;
        }
      }
    });
  },
);
