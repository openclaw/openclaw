import { readFile } from "node:fs/promises";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as pairingStore from "../../pairing/pairing-store.js";
import { buildLegacyDmAccountAllowlistAdapter } from "../../plugin-sdk/allowlist-config-edit.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const beforeConfigEdit = vi.fn(async () => {});

beforeEach(({ onTestFinished }) => {
  beforeConfigEdit.mockReset();
  const previous = captureActivePluginRegistrySnapshot();
  onTestFinished(() => {
    rollbackStagedPluginRegistry(previous);
  });
  const allowlist = buildLegacyDmAccountAllowlistAdapter({
    channelId: "discord",
    resolveAccount: ({ cfg, accountId }) =>
      cfg.channels?.discord?.accounts?.[accountId ?? "team"] ?? {},
    normalize: ({ values }) => values.map(String),
    resolveDmAllowFrom: (account) => account.allowFrom,
  });
  const discord: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "discord",
      config: {
        listAccountIds: () => ["team", "default"],
        resolveAccount: (cfg, accountId) =>
          cfg.channels?.discord?.accounts?.[accountId ?? "team"] ?? {},
        resolveAllowFrom: ({ cfg, accountId }) =>
          cfg.channels?.discord?.accounts?.[accountId ?? "team"]?.allowFrom,
      },
    }),
    pairing: { idLabel: "discordUserId" },
    allowlist: {
      ...allowlist,
      applyConfigEdit: async (params) => {
        await beforeConfigEdit();
        const result = await allowlist.applyConfigEdit?.(params);
        assert(result, "The DM config editor must handle the fixture's edit");
        return result;
      },
    },
  };
  stageActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", plugin: discord, source: "test" }]),
    null,
    "default",
  );
});

const mutations = [
  { action: "add", target: "--store", revocation: "demote" },
  { action: "remove", target: "--store", revocation: "unlink" },
  { action: "add", target: "", revocation: "reassign" },
] as const;

it.each(
  mutations.flatMap(({ action, target, revocation }) =>
    [false, true].map((revoke) => ({ action, target, revocation, revoke })),
  ),
)(
  "rechecks $action $target pairing writes after $revocation during preparation (revoke=$revoke)",
  async ({ action, target, revocation, revoke }) => {
    await withAdminIngress(async ({ cfg, admins, context, state }) => {
      cfg.commands = { ...cfg.commands, text: true, config: true };
      if (!target) {
        cfg.channels!.discord!.accounts!.team!.allowFrom = ["*", "200"];
      }
      await state.writeConfig(cfg);
      const originalConfig = await readFile(state.configPath, "utf8");
      await pairingStore.addChannelAllowFromStoreEntry({
        channel: "discord",
        accountId: "team",
        entry: "300",
      });
      if (action === "remove") {
        await pairingStore.addChannelAllowFromStoreEntry({
          channel: "discord",
          accountId: "team",
          entry: "200",
        });
      }
      const originalStore = await pairingStore.readChannelAllowFromStore(
        "discord",
        process.env,
        "team",
      );
      const admin = admins[0]!;
      const params = buildCommandTestParams(
        `/allowlist ${action} dm ${target} --account team 200`,
        cfg,
        await context(admin.identity.senderId),
      );
      expect(params.command.senderIsOwner).toBe(true);
      expect(params.command.assertOwnerCurrent).toBeTypeOf("function");
      const preparing = createDeferredCore();
      const finish = createDeferredCore();
      const pause = async () => {
        preparing.resolve();
        await finish.promise;
      };
      const method =
        action === "add" ? "addChannelAllowFromStoreEntry" : "removeChannelAllowFromStoreEntry";
      const originalWrite = pairingStore[method];
      const writer = target
        ? vi.spyOn(pairingStore, method).mockImplementation(async (entry) => {
            await pause();
            return originalWrite(entry);
          })
        : undefined;
      if (!target) {
        beforeConfigEdit.mockImplementation(pause);
      }
      const pending = handleAllowlistCommand(params, true).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      try {
        expect(
          await Promise.race([
            preparing.promise.then(() => "preparing"),
            pending.then(() => "finished"),
          ]),
        ).toBe("preparing");
        if (revoke) {
          if (revocation === "demote") {
            setUserProfileRole(admin.profile.id, "member");
          } else {
            unlinkUserChannelIdentity(admin.profile.id, admin.identity);
            if (revocation === "reassign") {
              linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
            }
          }
          params.command.assertOwnerCurrent = () => {};
        }
        finish.resolve();
        const outcome = await pending;
        const persisted = await pairingStore.readChannelAllowFromStore(
          "discord",
          process.env,
          "team",
        );
        expect(await readFile(state.configPath, "utf8")).toBe(originalConfig);
        if (revoke) {
          expect(outcome.error).toMatchObject({
            message: expect.stringContaining("authority changed"),
          });
          expect(persisted).toEqual(originalStore);
        } else {
          expect(outcome.error).toBeUndefined();
          expect(outcome.result?.reply?.text).toContain(
            action === "add" ? "allowlist added" : "allowlist removed",
          );
          expect(persisted).toEqual(action === "add" ? ["300", "200"] : ["300"]);
        }
      } finally {
        finish.resolve();
        await pending;
        writer?.mockRestore();
        beforeConfigEdit.mockReset();
      }
    });
  },
);

it.each([false, true])(
  "rechecks default-account cleanup after an accepted removal (revoke=%s)",
  async (revoke) => {
    await withAdminIngress(async ({ cfg, admins, context }) => {
      cfg.commands = { ...cfg.commands, text: true, config: true };
      await pairingStore.addChannelAllowFromStoreEntry({
        channel: "discord",
        accountId: "default",
        entry: "200",
      });
      const admin = admins[0]!;
      const params = buildCommandTestParams(
        "/allowlist remove dm --store --account default 200",
        cfg,
        await context(admin.identity.senderId),
      );
      const removed = createDeferredCore();
      const finish = createDeferredCore();
      const remove = pairingStore.removeChannelAllowFromStoreEntry;
      const writer = vi
        .spyOn(pairingStore, "removeChannelAllowFromStoreEntry")
        .mockImplementation(async (entry) => {
          const result = await remove(entry);
          if (entry.accountId === "default") {
            expect(result).toEqual({ changed: true, allowFrom: [] });
            removed.resolve();
            await finish.promise;
          }
          return result;
        });
      const pending = handleAllowlistCommand(params, true).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      try {
        expect(
          await Promise.race([
            removed.promise.then(() => "removed"),
            pending.then(() => "finished"),
          ]),
        ).toBe("removed");
        expect(await pairingStore.readChannelAllowFromStore("discord")).toEqual([]);
        await pairingStore.addChannelAllowFromStoreEntry({ channel: "discord", entry: "200" });
        if (revoke) {
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
          params.command.assertOwnerCurrent = () => {};
        }
        finish.resolve();
        const outcome = await pending;
        expect(await pairingStore.readChannelAllowFromStore("discord")).toEqual(
          revoke ? ["200"] : [],
        );
        if (revoke) {
          expect(outcome.error).toMatchObject({
            message: expect.stringContaining("authority changed"),
          });
        } else {
          expect(outcome.error).toBeUndefined();
          expect(outcome.result?.reply?.text).toContain("allowlist removed");
        }
      } finally {
        finish.resolve();
        await pending;
        writer.mockRestore();
      }
    });
  },
);

it("settles a committed pairing addition after the original admin is demoted", async () => {
  await withAdminIngress(async ({ cfg, admins, context }) => {
    cfg.commands = { ...cfg.commands, text: true, config: true };
    const admin = admins[0]!;
    const params = buildCommandTestParams(
      "/allowlist add dm --store --account team 200",
      cfg,
      await context(admin.identity.senderId),
    );
    const add = pairingStore.addChannelAllowFromStoreEntry;
    const writer = vi
      .spyOn(pairingStore, "addChannelAllowFromStoreEntry")
      .mockImplementation(async (entry) => {
        const result = await add(entry);
        setUserProfileRole(admin.profile.id, "member");
        return result;
      });
    try {
      const result = await handleAllowlistCommand(params, true);
      expect(result?.reply?.text).toContain("allowlist added");
      expect(await pairingStore.readChannelAllowFromStore("discord", process.env, "team")).toEqual([
        "200",
      ]);
      expect(params.command.assertOwnerCurrent).toThrow("authority changed");
    } finally {
      writer.mockRestore();
    }
  });
});
