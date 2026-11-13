// Real config IO: an account delete that also drops bindings commits through the writer's guards.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deleteChannelAccount,
  splitChannelAccountDelete,
} from "../../channels/plugins/account-delete-follow-up.js";
import { readConfigFileSnapshotForWrite } from "../../config/config.js";
import { withTempHome } from "../../config/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { persistAccountDeleteFollowUp } from "./account-delete-persistence.js";
import { persistChannelPluginConfig } from "./plugin-config-persistence.js";

const binding = (accountId: string) => ({
  agentId: "main",
  match: { channel: "telegram", accountId },
});
const runtime = { log: () => {}, error: () => {}, exit: () => {} };
const telegram = {
  botToken: "123:base",
  accounts: { team: { botToken: "456:team" } },
};

// What Telegram's delete adapter returns for the last named account: the entry and its bindings go.
function deleteLastAccount(cfg: OpenClawConfig): OpenClawConfig {
  const { accounts: _accounts, ...rest } = cfg.channels?.telegram ?? {};
  return { ...cfg, channels: { ...cfg.channels, telegram: rest }, bindings: undefined };
}

const deleteLastAccountAdapter = ({ cfg }: { cfg: OpenClawConfig; accountId: string }) =>
  deleteLastAccount(cfg);

async function writeFiles(home: string, files: Record<string, unknown>) {
  const dir = path.join(home, ".openclaw");
  await fs.mkdir(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2), "utf-8");
  }
  return dir;
}

async function readJson(dir: string, name: string) {
  return JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as Record<string, unknown>;
}

// Mirrors `channels remove --delete`: the delete's own write, then its follow-up to that file.
async function deleteAccountWrite() {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const cfg = snapshot.sourceConfig;
  const removed = splitChannelAccountDelete({ cfg, nextConfig: deleteLastAccount(cfg) });
  expect(removed.followUp?.paths).toEqual(["bindings"]);
  expect(removed.config.bindings).toEqual(cfg.bindings);
  const committed = await persistChannelPluginConfig({
    cfg: removed.config,
    pluginInstalled: false,
    writeOptions,
    baseHash: snapshot.hash,
    runtime,
  });
  return { followUp: removed.followUp!, configPath: committed.path };
}

async function persistFollowUp(
  followUp: Awaited<ReturnType<typeof deleteAccountWrite>>["followUp"],
  configPath: string,
) {
  const error = vi.fn();
  const written = await persistAccountDeleteFollowUp(followUp, configPath, { error });
  return { written, warning: error.mock.calls[0]?.[0] as string | undefined };
}

async function removeLastAccount() {
  const { followUp, configPath } = await deleteAccountWrite();
  expect(await persistFollowUp(followUp, configPath)).toEqual({
    written: true,
    warning: undefined,
  });
}

describe("account delete persistence", () => {
  it("hands changes outside channels to the sink only when there is one", () => {
    const cfg = { channels: { telegram }, bindings: [binding("team")] } as OpenClawConfig;
    const plugin = { config: { deleteAccount: deleteLastAccountAdapter } };
    const onAccountDeleteFollowUp = vi.fn();
    expect(deleteChannelAccount(cfg, undefined, "team", { onAccountDeleteFollowUp })).toBe(cfg);
    expect(deleteChannelAccount(cfg, { config: {} }, "team", { onAccountDeleteFollowUp })).toBe(
      cfg,
    );
    expect(deleteChannelAccount(cfg, plugin, "team")).toEqual(deleteLastAccount(cfg));
    const deferred = deleteChannelAccount(cfg, plugin, "team", { onAccountDeleteFollowUp });
    expect(deferred).toEqual({ ...deleteLastAccount(cfg), bindings: cfg.bindings });
    expect(onAccountDeleteFollowUp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ paths: ["bindings"] }),
    );
    const channelsOnly = { config: { deleteAccount: () => ({ channels: {} }) as OpenClawConfig } };
    expect(
      deleteChannelAccount({ channels: { telegram } }, channelsOnly, "team", {
        onAccountDeleteFollowUp,
      }),
    ).toEqual({ channels: {} });
    expect(onAccountDeleteFollowUp).toHaveBeenCalledOnce();
  });

  it("keeps channels-only deletes in a single write", () => {
    const cfg = { channels: { telegram }, bindings: [binding("team")] } as OpenClawConfig;
    const nextConfig = { ...cfg, channels: { telegram: { botToken: "123:base" } } };
    expect(splitChannelAccountDelete({ cfg, nextConfig })).toEqual({ config: nextConfig });
  });

  it.each([
    ["the channel section is included", { channels: { telegram: { $include: "./tg.json" } } }],
    ["bindings are included", { channels: { telegram }, bindings: { $include: "./bind.json" } }],
    [
      "both are included from separate files",
      { channels: { telegram: { $include: "./tg.json" } }, bindings: { $include: "./bind.json" } },
    ],
  ])("completes the delete when %s", async (_case, root) => {
    await withTempHome(async (home) => {
      const dir = await writeFiles(home, {
        "openclaw.json": { bindings: [binding("team")], ...root },
        "tg.json": telegram,
        "bind.json": [binding("team")],
      });
      await removeLastAccount();
      const { snapshot } = await readConfigFileSnapshotForWrite();
      expect(snapshot.sourceConfig.channels?.telegram).toEqual({ botToken: "123:base" });
      expect(snapshot.sourceConfig.bindings ?? []).toEqual([]);
      expect(JSON.stringify(await readJson(dir, "openclaw.json"))).toContain("$include");
      if ("bindings" in root) {
        expect(await readJson(dir, "bind.json")).toEqual([]);
      }
    });
  });

  it("completes the delete when dropping bindings shrinks a small config below half", async () => {
    await withTempHome(async (home) => {
      const bindings = ["alpha", "bravo", "charlie", "delta", "echo", "team"].map(binding);
      const dir = await writeFiles(home, { "openclaw.json": { channels: { telegram }, bindings } });
      expect((await fs.stat(path.join(dir, "openclaw.json"))).size).toBeGreaterThanOrEqual(512);
      const { followUp, configPath } = await deleteAccountWrite();
      const inMemory = {
        channels: { telegram: { botToken: "123:base" } },
        bindings,
      } as OpenClawConfig;
      await expect(
        persistAccountDeleteFollowUp(followUp, configPath, runtime, [inMemory]),
      ).resolves.toBe(true);
      expect(inMemory.bindings).toBeUndefined();
      const after = await readJson(dir, "openclaw.json");
      expect(after.bindings).toBeUndefined();
      expect(after.channels).toEqual({ telegram: { botToken: "123:base" } });
    });
  });

  it.each([
    [
      "bindings changed",
      {
        channels: { telegram: { botToken: "123:base" } },
        bindings: [binding("team"), binding("ops")],
      },
      "bindings changed after the delete was prepared",
    ],
    [
      "the account was added back",
      { channels: { telegram }, bindings: [binding("team")] },
      "channels.telegram.accounts changed after the delete was prepared",
    ],
  ])("leaves bindings alone when %s after the delete", async (_case, current, message) => {
    await withTempHome(async (home) => {
      await writeFiles(home, {
        "openclaw.json": { channels: { telegram }, bindings: [binding("team")] },
      });
      const { followUp, configPath } = await deleteAccountWrite();
      const dir = await writeFiles(home, { "openclaw.json": current });
      const { written, warning } = await persistFollowUp(followUp, configPath);
      expect(written).toBe(false);
      expect(warning).toContain(message);
      expect(await readJson(dir, "openclaw.json")).toEqual(current);
    });
  });

  it("writes the follow-up to the file the delete was written to", async () => {
    await withTempHome(async (home) => {
      const dir = await writeFiles(home, {
        "openclaw.json": { channels: { telegram }, bindings: [binding("team")] },
        "decoy.json": {
          channels: { telegram: { botToken: "123:base" } },
          bindings: [binding("team")],
          gateway: { mode: "local" },
        },
      });
      const { followUp, configPath } = await deleteAccountWrite();
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(dir, "decoy.json"));
      try {
        expect((await persistFollowUp(followUp, configPath)).written).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
      const written = await readJson(dir, "openclaw.json");
      expect(written.bindings).toBeUndefined();
      expect(written.gateway).toBeUndefined();
      expect((await readJson(dir, "decoy.json")).bindings).toEqual([binding("team")]);
    });
  });

  it("reports a failed follow-up and keeps the in-memory config as written", async () => {
    await withTempHome(async (home) => {
      await writeFiles(home, {
        "openclaw.json": { channels: { telegram }, bindings: [binding("team")] },
      });
      const { followUp, configPath } = await deleteAccountWrite();
      await writeFiles(home, {
        "openclaw.json": { channels: { telegram }, bindings: [binding("team")] },
      });
      const error = vi.fn();
      const config = { bindings: [binding("team")] } as OpenClawConfig;
      await expect(
        persistAccountDeleteFollowUp(followUp, configPath, { error }, [config]),
      ).resolves.toBe(false);
      expect(error).toHaveBeenCalledExactlyOnceWith(
        "Could not update bindings after deleting the account. Check bindings and finish the cleanup by hand if it is still needed. Reason: channels.telegram.accounts changed after the delete was prepared",
      );
      expect(config.bindings).toEqual([binding("team")]);
    });
  });
});
