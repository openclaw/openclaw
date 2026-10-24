import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
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

installConfigWriteGatewayHooks();

it("accepts exact numeric record keys in replacePaths", async () => {
  const original = await getCurrentConfigObject();
  const channels = asOptionalRecord(original.config.channels) ?? {};
  const discord = {
    ...asOptionalRecord(channels.discord),
    allowFrom: ["*"],
    guilds: { "123": { channels: { general: { users: ["111", "222"] } } } },
  };
  await apply({ ...original.config, channels: { ...channels, discord } }, original.hash);

  try {
    const patchedDiscord = { guilds: { "123": { channels: { general: { users: ["111"] } } } } };
    const { after } = await patch(
      { channels: { discord: patchedDiscord } },
      "channels.discord.guilds.123.channels.general.users",
    );
    expect(after.config).toMatchObject({ channels: { discord: patchedDiscord } });
    await apply(after.config, after.hash);
    expect(getRuntimeConfig().channels).toBeUndefined();
  } finally {
    await restoreConfigFileForTest(original);
  }
});

it("allows nested destructive array patches inside id-keyed arrays with replacePaths", async () => {
  const original = await getCurrentConfigObject();
  const agents = {
    ...asOptionalRecord(original.config.agents),
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
    const beforeEntries = asOptionalRecord(asOptionalRecord(before.config.agents)?.entries);
    expect(asOptionalRecord(after.config.agents)?.entries).toEqual({
      ...beforeEntries,
      main: { ...asOptionalRecord(beforeEntries?.main), skills: ["alpha"] },
    });
  } finally {
    await restoreConfigFileForTest(original);
  }
});
