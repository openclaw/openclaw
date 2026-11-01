import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSessionTranscriptChannelRead } from "./memory-core-host-engine-sessions.js";

const requester = "agent:main:slack:channel:c111:thread:1.001";
const sibling = "agent:main:slack:channel:c111:thread:1.002";
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: { sessions: { visibility: "channel" } },
};

it("keeps standalone self reads and rejects async consumers and cross-session aliases", async () => {
  const target = {
    agentId: "main",
    key: requester,
    expectedSessionId: "self",
    storePath: "(self)",
  };
  const prepare = (groups: (typeof target)[][]) =>
    prepareSessionTranscriptChannelRead({
      cfg,
      requesterAgentId: "main",
      requesterSessionKey: requester,
      sandboxed: false,
      groups,
    });
  const self = await prepare([[target]]);
  expect(await self.withCurrentAccess((visible) => [...visible])).toEqual([true]);
  await expect(
    prepareSessionTranscriptChannelRead({
      cfg,
      requesterAgentId: "main",
      requesterSessionKey: " ",
      sandboxed: false,
      groups: [[target]],
    }),
  ).rejects.toThrow("requires a requesting session");
  await expect(
    Reflect.apply(self.withCurrentAccess, undefined, [async () => "invalid async consumer"]),
  ).rejects.toThrow("must remain synchronous");
  const ambiguous = await prepare([[target, { ...target, key: sibling }]]);
  await expect(ambiguous.withCurrentAccess((visible) => [...visible])).rejects.toThrow(
    "requires the local Gateway read owner",
  );
});
