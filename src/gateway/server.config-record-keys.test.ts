// Record-key config patches exercise persisted source and suppressed runtime projections.
import { describe, expect, it } from "vitest";
import {
  getCurrentConfigObject,
  installConfigWriteGatewayHooks,
  requireClient,
  requireConfigObject,
  restoreConfigFileForTest,
  rpcReq,
  sendConfigApply,
} from "../../test/helpers/gateway/config-rpc-gateway.js";
import { getRuntimeConfig } from "../config/config.js";
import { configRawPayload } from "./server.config-patch.test-support.js";

describe("gateway config methods", () => {
  // Channel policy replaces plugin runtime, which global per-case cleanup retires.
  installConfigWriteGatewayHooks();

  it("accepts exact numeric record keys in replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const channels =
      original.config.channels &&
      typeof original.config.channels === "object" &&
      !Array.isArray(original.config.channels)
        ? (original.config.channels as Record<string, unknown>)
        : {};
    const discord = {
      ...(channels.discord as Record<string, unknown> | undefined),
      allowFrom: ["*"],
      guilds: {
        "123": {
          channels: {
            general: {
              users: ["111", "222"],
            },
          },
        },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, channels: { ...channels, discord } }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({
          channels: {
            discord: {
              guilds: { "123": { channels: { general: { users: ["111"] } } } },
            },
          },
        }),
        baseHash: before.hash,
        replacePaths: ["channels.discord.guilds.123.channels.general.users"],
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      const afterChannels = requireConfigObject(after.config.channels, "channels");
      expect(
        (
          afterChannels.discord as {
            guilds?: { "123"?: { channels?: { general?: { users?: unknown[] } } } };
          }
        ).guilds?.["123"]?.channels?.general?.users,
      ).toEqual(["111"]);
      const reapplied = await sendConfigApply(configRawPayload(after.config, after.hash));
      expect(reapplied.ok, reapplied.error?.message).toBe(true);
      expect(getRuntimeConfig().channels).toBeUndefined();
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows nested destructive array patches inside id-keyed arrays with replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      ownership: "explicit",
      entries: {
        main: { skills: ["alpha", "beta"] },
        worker: { skills: ["gamma"] },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok, seed.error?.message).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> }).entries;
      const res = await rpcReq<{ ok?: boolean }>(requireClient(), "config.patch", {
        raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
        baseHash: before.hash,
        replacePaths: ["agents.entries.main.skills"],
      });

      expect(res.ok, res.error?.message).toBe(true);
      const after = await getCurrentConfigObject();
      expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual({
        ...beforeEntries,
        main: {
          ...(beforeEntries?.main as Record<string, unknown> | undefined),
          skills: ["alpha"],
        },
      });
    } finally {
      await restoreConfigFileForTest(original);
    }
  });
});
