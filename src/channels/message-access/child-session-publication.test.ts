import { describe, expect, it } from "vitest";
import { prepareChannelRunAdmission } from "../../auto-reply/reply/channel-run-admission.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  admitChildSessionPublication,
  bindChildSessionPublication,
  copyChildSessionPublication,
  readChildSessionPublication,
} from "./child-session-publication.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

const parentKey = "agent:main:test:group:thread";
async function fixture(kind = "public") {
  let active = true;
  const gateway = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
  const owner = { channelId: "test", isLive: () => active, resolveGatewayContext: () => gateway };
  const input = {
    channelId: "test",
    accountId: "default",
    subject: { stableId: "author" },
    conversation: { kind: "group" as const, id: "thread" },
    contextBinding: {
      agentId: "main",
      sessionKey: parentKey,
      messageId: "post",
      inboundEventKind: "user_request" as const,
    },
    dmPolicy: "disabled" as const,
    groupPolicy: "open" as const,
    useDefaultPairingStore: false,
    ...(kind === "absent"
      ? {}
      : {
          childSessionPublication: {
            audience: "public" as const,
            assertCurrent: () => {
              if (!active) {
                throw new Error("revoked");
              }
            },
          },
        }),
  };
  const ingress = await createHostChannelIngressRuntime(owner).resolveStable(input);
  const context = await createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  )({
    channel: "test",
    accountId: "default",
    messageId: "post",
    from: "test:thread",
    sender: { id: "author" },
    conversation: { kind: "group", id: "thread" },
    route: {
      agentId: "main",
      routeSessionKey: kind === "retargeted" ? "agent:main:other" : parentKey,
    },
    reply: { to: "test:thread" },
    message: { body: "Public request", rawBody: "Public request" },
    channelIngress: kind === "forged" ? { ...ingress } : ingress,
  });
  const run = { runId: "run", instanceId: "instance" };
  const followup = {};
  copyChildSessionPublication(context, followup);
  admitChildSessionPublication(followup, run, () => {
    if (!active) {
      throw new Error("run closed");
    }
  });
  return {
    run,
    context,
    publication: readChildSessionPublication(run),
    close: () => {
      active = false;
    },
  };
}

describe("trusted ingress child publication", () => {
  it("binds through actual channel-run admission and rejects use after it closes", async () => {
    const context = {};
    bindChildSessionPublication(context, parentKey, () => {});
    const preparation = prepareChannelRunAdmission({
      cfg: {},
      runId: "publication-admission",
      agentId: "main",
      ingressKind: "channel",
      boundary: "publication-test",
      sourceContext: context,
    });
    try {
      const admitted = await preparation.admit("embedded");
      const publication = readChildSessionPublication(admitted.operationalRunInstance);
      expect(publication).toBeDefined();
      expect(() => publication!.assertCurrent()).not.toThrow();
      preparation.close();
      expect(() => publication!.assertCurrent()).toThrow("run is no longer active");
    } finally {
      preparation.close();
    }
  });

  it.each(["public", "absent", "retargeted", "forged"])(
    "accepts only an exact host handoff: %s",
    async (kind) => {
      const f = await fixture(kind);
      expect(Boolean(f.publication)).toBe(kind === "public");
    },
  );
  it("never transfers to a later turn or grandchild and expires with the source", async () => {
    const f = await fixture();
    const later = { runId: "later", instanceId: "later" };
    admitChildSessionPublication(f.context, later, () => {});
    expect(readChildSessionPublication(later)).toBeUndefined();
    const claim = {
      sessionKey: "agent:main:dashboard:child",
      entry: { sessionId: "child", updatedAt: 1 },
      parentSessionKey: parentKey,
      parent: { sessionId: "parent", updatedAt: 1 },
      isNew: true,
    };
    expect(() => f.publication!.claim(claim)).not.toThrow();
    expect(() =>
      f.publication!.claim({
        ...claim,
        sessionKey: "agent:main:dashboard:second",
        entry: { sessionId: "second", updatedAt: 1 },
      }),
    ).not.toThrow();
    f.close();
    expect(() => f.publication!.assertCurrent()).toThrow();
  });
  it.each(["existing", "fork", "private", "incognito", "other-parent"])(
    "rejects %s targets",
    async (kind) => {
      const f = await fixture();
      expect(() =>
        f.publication!.claim({
          sessionKey: "agent:main:dashboard:child",
          entry: {
            sessionId: "child",
            updatedAt: 1,
            ...(kind === "private" ? { visibility: "draft" as const } : {}),
            incognito: kind === "incognito" ? true : undefined,
          },
          parentSessionKey: kind === "other-parent" ? "agent:main:other" : parentKey,
          parent: { sessionId: "parent", updatedAt: 1 },
          isNew: kind !== "existing",
          fork: kind === "fork",
        }),
      ).toThrow();
    },
  );
});
