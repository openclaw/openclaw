import { expect, it, vi } from "vitest";
import { prepareChannelRunAdmission } from "../../auto-reply/reply/channel-run-admission.js";
import {
  admitChildSessionPublication,
  bindChildSessionPublication,
  copyChildSessionPublication,
  readChildSessionPublication,
} from "./child-session-publication.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "./host-ingress.test-support.js";

const parentKey = "agent:main:test:group:thread";
const childClaim = {
  sessionKey: "agent:main:dashboard:child",
  entry: { sessionId: "child", updatedAt: 1 },
  parentSessionKey: parentKey,
  parent: { sessionId: "parent", updatedAt: 1 },
  isNew: true,
};
const prepareAdmission = (sourceContext: object, runId = "publication-admission") =>
  prepareChannelRunAdmission({
    cfg: {},
    runId,
    agentId: "main",
    ingressKind: "channel",
    boundary: "publication-test",
    sourceContext,
  });

async function fixture(kind = "public") {
  const host = createHostIngressFixture();
  const assertCurrent = () => {
    if (!host.owner.isLive()) {
      throw new Error("revoked");
    }
  };
  const message = ingressMessage("test", parentKey, "author", {
    conversation: { kind: "group", id: "thread" },
  });
  const ingress = await host.ingress.resolveStable(
    ingressInput(message, {
      dmPolicy: "disabled",
      groupPolicy: "open",
      allowFrom: undefined,
      childSessionPublication:
        kind === "absent" ? undefined : { audience: "public", assertCurrent },
    }),
  );
  const context = host.buildContext({
    ...message,
    route: {
      agentId: "main",
      routeSessionKey: kind === "retargeted" ? "agent:main:other" : parentKey,
    },
    channelIngress: kind === "forged" ? { ...ingress } : ingress,
  });
  const run = { runId: "run", instanceId: "instance" };
  const followup = {};
  copyChildSessionPublication(context, followup);
  admitChildSessionPublication(followup, run, assertCurrent);
  return { context, publication: readChildSessionPublication(run), close: host.retire };
}

it.each(["source revocation", "run closure"])("publication expires on %s", async (phase) => {
  let current = true;
  const context = {};
  const prepare = vi.fn(async () => () => {
    if (!current) {
      throw new Error("revoked after admission");
    }
  });
  bindChildSessionPublication(
    context,
    parentKey,
    () => {
      if (phase === "source revocation") {
        throw new Error("stale original snapshot");
      }
    },
    phase === "source revocation" ? prepare : undefined,
  );
  const admission = prepareAdmission(context, "renewed-publication");
  try {
    const admitted = await admission.admit("embedded");
    const publication = readChildSessionPublication(admitted.operationalRunInstance);
    expect(publication).toBeDefined();
    expect(() => publication?.assertCurrent()).not.toThrow();
    if (phase === "source revocation") {
      current = false;
      await admission.admit("embedded");
      await publication?.prepare();
      expect(prepare).toHaveBeenCalledOnce();
    } else {
      admission.close();
    }
    expect(() => publication?.assertCurrent()).toThrow(
      phase === "source revocation" ? "revoked after admission" : "run is no longer active",
    );
  } finally {
    admission.close();
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
  expect(() => f.publication!.claim(childClaim)).not.toThrow();
  expect(() =>
    f.publication!.claim({
      ...childClaim,
      sessionKey: "agent:main:dashboard:second",
      entry: { sessionId: "second", updatedAt: 1 },
    }),
  ).not.toThrow();
  f.close();
  expect(() => f.publication!.assertCurrent()).toThrow();
});
it.each([
  ["existing", { isNew: false }],
  ["fork", { fork: true }],
  ["private", { entry: { ...childClaim.entry, visibility: "draft" } }],
  ["incognito", { entry: { ...childClaim.entry, incognito: true } }],
  ["other-parent", { parentSessionKey: "agent:main:other" }],
] as const)("rejects %s targets", async (_kind, overrides) => {
  const f = await fixture();
  expect(() => f.publication!.claim({ ...childClaim, ...overrides })).toThrow();
});
