// Record-key config patches exercise persisted source and suppressed runtime projections.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  getCurrentConfigObject,
  installConfigWriteGatewayHooks,
  requireClient,
  restoreConfigFileForTest,
  rpcReq,
  sendConfigApply,
} from "../../test/helpers/gateway/config-rpc-gateway.js";
import { getRuntimeConfig } from "../config/config.js";
import { configRawPayload } from "./server.config-patch.test-support.js";

async function apply(config: Record<string, unknown>, hash: string) {
  const result = await sendConfigApply(configRawPayload(config, hash));
  expect(result.ok, result.error?.message).toBe(true);
}

async function patch(raw: unknown, replacePath: string) {
  const before = await getCurrentConfigObject();
  const result = await rpcReq(requireClient(), "config.patch", {
    raw: JSON.stringify(raw),
    baseHash: before.hash,
    replacePaths: [replacePath],
  });
  expect(result.ok, result.error?.message).toBe(true);
  return { before, after: await getCurrentConfigObject() };
}

describe("gateway config methods", () => {
  // Channel policy replaces plugin runtime, which global per-case cleanup retires.
  installConfigWriteGatewayHooks();

  it("accepts exact numeric record keys in replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const channels = asOptionalRecord(original.config.channels) ?? {};
    const discord = {
      ...(channels.discord as Record<string, unknown> | undefined),
      allowFrom: ["*"],
      guilds: { "123": { channels: { general: { users: ["111", "222"] } } } },
    };
    await apply({ ...original.config, channels: { ...channels, discord } }, original.hash);

    try {
      const { after } = await patch(
        {
          channels: {
            discord: { guilds: { "123": { channels: { general: { users: ["111"] } } } } },
          },
        },
        "channels.discord.guilds.123.channels.general.users",
      );
      expect(after.config).toMatchObject({
        channels: { discord: { guilds: { "123": { channels: { general: { users: ["111"] } } } } } },
      });
      await apply(after.config, after.hash);
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
    await apply({ ...original.config, agents }, original.hash);

    try {
      const { before, after } = await patch(
        { agents: { entries: { main: { skills: ["alpha"] } } } },
        "agents.entries.main.skills",
      );
      const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> }).entries;
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
