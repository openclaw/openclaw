import { expect, it } from "vitest";
import { createSessionChannelReadFixture } from "../agents/tools/sessions-channel-read-result.test-support.js";
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

it.each(["channel", "self"] as const)(
  "admits SDK transcript reads with the initial %s policy and applies reloads next time",
  async (initialVisibility) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      tools: { sessions: { visibility: initialVisibility } },
    };
    const owner = createSessionChannelReadFixture(
      [requester, sibling].map((key) => ({
        key,
        sessionId: key,
        chatType: "channel" as const,
        space: "t111",
        origin: { provider: "slack" },
        deliveryContext: { channel: "slack", accountId: "default", to: "channel:c111" },
      })),
      config,
    );
    const prepare = () =>
      owner.run(() =>
        prepareSessionTranscriptChannelRead({
          cfg: config,
          requesterAgentId: "main",
          requesterSessionKey: requester,
          sandboxed: false,
          groups: [
            [
              {
                agentId: "main",
                key: sibling,
                expectedSessionId: sibling,
                storePath: owner.projection.describe({ agentId: "main", key: sibling })!.storeTarget
                  .storePath,
              },
            ],
          ],
        }),
      );
    const admitted = await prepare();
    config.tools = { sessions: { visibility: "self" } };
    expect(await owner.run(() => admitted.withCurrentAccess((visible) => [...visible]))).toEqual([
      initialVisibility === "channel",
    ]);
    const next = await prepare();
    expect(await owner.run(() => next.withCurrentAccess((visible) => [...visible]))).toEqual([
      false,
    ]);
  },
);
