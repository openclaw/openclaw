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
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const beforeConfigEdit = vi.fn(async () => {});
type AdminFixture = Parameters<Parameters<typeof withAdminIngress>[0]>[0];

function withCommandIngress(
  run: (fixture: AdminFixture, admin: AdminFixture["admins"][number]) => Promise<void>,
) {
  return withAdminIngress(async (fixture) => {
    fixture.cfg.commands = { ...fixture.cfg.commands, text: true, config: true };
    await run(fixture, fixture.admins[0]!);
  });
}

async function commandParams(fixture: AdminFixture, body: string) {
  return buildCommandTestParams(
    body,
    fixture.cfg,
    await fixture.context(fixture.admins[0]!.identity.senderId),
  );
}

const addEntry = (entry: string, accountId?: string) =>
  pairingStore.addChannelAllowFromStoreEntry({ channel: "discord", accountId, entry });
const readStore = (accountId?: string) =>
  pairingStore.readChannelAllowFromStore("discord", process.env, accountId);

function startCommand(params: Awaited<ReturnType<typeof commandParams>>) {
  return handleAllowlistCommand(params, true).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
}

function expectOutcome(
  outcome: Awaited<ReturnType<typeof startCommand>>,
  revoke: boolean,
  action = "remove",
) {
  if (revoke) {
    expect(outcome.error).toMatchObject({ message: expect.stringContaining("authority changed") });
  } else {
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.reply?.text).toContain(
      `allowlist ${action === "add" ? "added" : "removed"}`,
    );
  }
}

async function withPausedWrite(
  params: Awaited<ReturnType<typeof commandParams>>,
  action: "add" | "remove" | "config",
  afterRemoval: boolean,
  run: (resume: () => ReturnType<typeof startCommand>) => Promise<void>,
) {
  const ready = createDeferredCore(),
    finish = createDeferredCore();
  const pause = async () => {
    ready.resolve();
    await finish.promise;
  };
  const method =
    action === "add" ? "addChannelAllowFromStoreEntry" : "removeChannelAllowFromStoreEntry";
  const original = pairingStore[method];
  const writer =
    action === "config"
      ? undefined
      : vi.spyOn(pairingStore, method).mockImplementation(async (entry) => {
          if (!afterRemoval) {
            await pause();
            return original(entry);
          }
          const result = await original(entry);
          if (entry.accountId === "default") {
            expect(result).toEqual({ changed: true, allowFrom: [] });
            await pause();
          }
          return result;
        });
  if (action === "config") {
    beforeConfigEdit.mockImplementation(pause);
  }
  const pending = startCommand(params);
  try {
    expect(
      await Promise.race([ready.promise.then(() => "paused"), pending.then(() => "finished")]),
    ).toBe("paused");
    await run(() => {
      finish.resolve();
      return pending;
    });
  } finally {
    finish.resolve();
    await pending;
    writer?.mockRestore();
    beforeConfigEdit.mockReset();
  }
}

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
  { action: "add", target: "--store", revocation: "demote", revoke: true },
  { action: "remove", target: "--store", revocation: "unlink", revoke: false },
  { action: "remove", target: "--store", revocation: "unlink", revoke: true },
  { action: "add", target: "", revocation: "reassign", revoke: false },
  { action: "add", target: "", revocation: "reassign", revoke: true },
] as const;

it.each(mutations)(
  "rechecks $action $target pairing writes after $revocation during preparation (revoke=$revoke)",
  ({ action, target, revocation, revoke }) =>
    withCommandIngress(async (fixture, admin) => {
      const { cfg, admins, state } = fixture;
      if (!target) {
        cfg.channels!.discord!.accounts!.team!.allowFrom = ["*", "200"];
      }
      await state.writeConfig(cfg);
      const originalConfig = await readFile(state.configPath, "utf8");
      await addEntry("300", "team");
      if (action === "remove") {
        await addEntry("200", "team");
      }
      const originalStore = await readStore("team");
      const params = await commandParams(
        fixture,
        `/allowlist ${action} dm ${target} --account team 200`,
      );
      expect(params.command.senderIsOwner).toBe(true);
      expect(params.command.assertOwnerCurrent).toBeTypeOf("function");
      await withPausedWrite(params, target ? action : "config", false, async (resume) => {
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
        const outcome = await resume();
        const persisted = await readStore("team");
        expect(await readFile(state.configPath, "utf8")).toBe(originalConfig);
        expectOutcome(outcome, revoke, action);
        expect(persisted).toEqual(
          revoke ? originalStore : action === "add" ? ["300", "200"] : ["300"],
        );
      });
    }),
);

it.each([false, true])(
  "rechecks default-account cleanup after an accepted removal (revoke=%s)",
  (revoke) =>
    withCommandIngress(async (fixture, admin) => {
      await addEntry("200", "default");
      const params = await commandParams(
        fixture,
        "/allowlist remove dm --store --account default 200",
      );
      await withPausedWrite(params, "remove", true, async (resume) => {
        expect(await readStore()).toEqual([]);
        await addEntry("200");
        if (revoke) {
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
          params.command.assertOwnerCurrent = () => {};
        }
        const outcome = await resume();
        expect(await readStore()).toEqual(revoke ? ["200"] : []);
        expectOutcome(outcome, revoke);
      });
    }),
);

it("settles a committed pairing addition after the original admin is demoted", async () => {
  await withCommandIngress(async (fixture, admin) => {
    const params = await commandParams(fixture, "/allowlist add dm --store --account team 200");
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
      expect(await readStore("team")).toEqual(["200"]);
      expect(params.command.assertOwnerCurrent).toThrow("authority changed");
    } finally {
      writer.mockRestore();
    }
  });
});
