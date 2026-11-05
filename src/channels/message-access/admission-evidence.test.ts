import { afterEach, expect, it, vi } from "vitest";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  buildChannelInboundEventContext,
  buildHostChannelInboundEventContext,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import { publicResultScopeKey } from "./admission-evidence-scope-key.js";
import {
  combineChannelAdmissionEvidence as combineEvidence,
  createChannelAdmissionAudit,
  type ChannelAdmissionAudit,
  consumeChannelAdmissionEvidence as consumeEvidence,
  copyChannelParticipantAdmissionEvidence as copyEvidence,
  readChannelContextAdmissionEvidence as readEvidence,
  readChannelContextGatewayContextResolver as readResolver,
  type ChannelAdmissionEvidence,
} from "./admission-evidence.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "./host-ingress.test-support.js";
import { createHostChannelIngressRuntime, resolveStableChannelIngressPolicy } from "./runtime.js";

const unknownEvidence = {
  ingressState: "unknown",
  invoker: { state: "unknown" },
  decisionCoverage: "unknown",
};
const admittedEvidence = (participant: string) => ({
  ingressState: "present",
  invoker: {
    state: "present",
    kind: "person",
    rawPrincipalRef: JSON.stringify(["test", "acct:primary", participant]),
  },
  assuranceRef: "channel-admission",
  decisionCoverage: "enforced",
  identifierAuthentication: "evaluated",
});
const audits: ChannelAdmissionAudit[] = [];
function createAudit(enabled = true) {
  const audit = createChannelAdmissionAudit({ enabled });
  audits.push(audit);
  return audit;
}
afterEach(() => {
  for (const audit of audits.splice(0)) {
    audit.close();
  }
  vi.useRealTimers();
});

function makeContext(senderId: string, messageId?: string) {
  return ingressMessage("test", "agent:main:test:dm:dm-1", senderId, {
    accountId: "acct:primary",
    messageId,
  });
}

function createOwner(audit: ChannelAdmissionAudit, resolveGatewayContext?: GatewayContextResolver) {
  const { owner } = createHostIngressFixture("test", {}, { channelAdmissionAudit: audit });
  return resolveGatewayContext ? { ...owner, resolveGatewayContext } : owner;
}

async function admittedContext(
  audit: ChannelAdmissionAudit,
  participantId: string,
  allowFrom = [participantId],
  resolveGatewayContext?: GatewayContextResolver,
) {
  const owner = createOwner(audit, resolveGatewayContext);
  const params = makeContext(participantId, "msg-1");
  const channelIngress = await createHostChannelIngressRuntime(owner).resolveStable(
    ingressInput(params, {
      subject: { stableId: participantId },
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom,
    }),
  );
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  return buildContext({ ...params, channelIngress });
}

async function evidenceFor(audit: ChannelAdmissionAudit, participantId: string) {
  return readEvidence(await admittedContext(audit, participantId));
}

function inspect(context: object) {
  return consumeEvidence(readEvidence(context));
}
function expectUnknown(evidence: ChannelAdmissionEvidence | undefined) {
  expect(consumeEvidence(evidence)).toMatchObject(unknownEvidence);
}
function unreadableAfter<T extends object>(target: T, field: PropertyKey, after = 0): T {
  let reads = 0;
  return new Proxy(target, {
    getOwnPropertyDescriptor(value, key) {
      if (key === field && reads++ >= after) {
        throw new Error("descriptor unavailable");
      }
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
}

it("keeps Gateway routing instance-bound when audit collection is disabled", async () => {
  const audit = createAudit(false);
  const { gateway: gatewayContext } = createHostIngressFixture("test");
  let live = true;
  const source = await admittedContext(audit, "person:42", ["person:42"], () =>
    live ? gatewayContext : undefined,
  );
  const copied = { ...source };

  copyEvidence(source, copied);

  expect(readResolver(source)?.()).toBe(gatewayContext);
  expect(readResolver(copied)?.()).toBe(gatewayContext);
  live = false;
  expect(readResolver(source)?.()).toBeUndefined();
});

it("carries the resolver participant to one run admission without route inference", async () => {
  const evidence = await evidenceFor(createAudit(), "person:42");
  const consumed = consumeEvidence(evidence);

  expect(consumed).toEqual(admittedEvidence("person:42"));
  expectUnknown(evidence);
});

it("rejects implicit context custody transfer and forged private carriers", async () => {
  const source = await admittedContext(createAudit(), "person-a");
  const copiedDescriptors = Object.defineProperties({}, Object.getOwnPropertyDescriptors(source));
  const forged = { ...source };
  const forgedResolver = vi.fn();
  for (const key of Object.getOwnPropertySymbols(source)) {
    Object.defineProperty(forged, key, {
      value: {
        context: forged,
        resolver: forgedResolver,
        evidence: { kind: "channel-admission-evidence" },
      },
      configurable: true,
    });
  }
  for (const candidate of [{ ...source }, Object.create(source), copiedDescriptors, forged]) {
    expect(readResolver(candidate)).toBeUndefined();
    expect(inspect(candidate)).toMatchObject(unknownEvidence);
  }
  expect(inspect(source)).toMatchObject({ ingressState: "present" });
});

it("cannot bootstrap evidence through the public copy helper", () => {
  const source = { OriginatingChannel: "test", AccountId: "default", SenderId: "person-a" };
  const target = { ...source };

  copyEvidence(source, target);

  expect(readEvidence(target)).toBeUndefined();
});

it.each([
  ["unchanged", {}],
  ["unreadable", {}],
  ["consumed", {}],
  ["participant", { SenderId: "person-b" }],
  ["route", { SessionKey: "agent:other:test:dm:dm-1" }],
  ["thread", { MessageThreadId: "thread-2" }],
  ["native channel", { NativeChannelId: "native-2" }],
  ["message", { MessageSid: "msg-2", MessageSidFull: "msg-2" }],
])("copies admission only to a readable, unchanged, unconsumed scope: %s", async (kind, patch) => {
  const source = await admittedContext(createAudit(), "person-a");
  if (kind === "consumed") {
    expect(inspect(source)).toMatchObject({ ingressState: "present" });
  }
  const copy = { ...source, ...patch };
  const target = kind === "unreadable" ? unreadableAfter(copy, "NativeDirectUserId") : copy;
  copyEvidence(source, target);
  expect(inspect(target)).toMatchObject(
    kind === "unchanged"
      ? { ingressState: "present", invoker: { state: "present", kind: "person" } }
      : unknownEvidence,
  );
  if (kind === "unreadable") {
    expect(readResolver(target)).toBeUndefined();
  }
});

it("rejects an event whose symbol descriptor becomes unreadable without throwing", async () => {
  const result = await resolveStableChannelIngressPolicy(ingressInput(makeContext("person-1")));
  const key = Symbol("unreadable-event-field");
  result.state.event = unreadableAfter({ ...result.state.event, [key]: true }, key, 1);
  expect(publicResultScopeKey(result)).toBeUndefined();
});

it("reports same-participant collection while mixed participants fail closed", async () => {
  const audit = createAudit();
  const combined = async (...participants: string[]) =>
    combineEvidence(await Promise.all(participants.map((id) => evidenceFor(audit, id))));
  expect(consumeEvidence(await combined("c", "c"))).toEqual(admittedEvidence("c"));
  expectUnknown(await combined("c", "b:c"));
});

it("keeps wildcard admission attribution-only because identity did not affect the outcome", async () => {
  const context = await admittedContext(createAudit(), "person-42", ["*"]);
  expect(inspect(context)).toMatchObject({
    ingressState: "present",
    invoker: { state: "present", kind: "person" },
    decisionCoverage: "attribution-only",
  });
});

it("rejects forged and prior-lifecycle carriers and stays empty when collection is disabled", async () => {
  const audit = createAudit();
  const stale = await evidenceFor(audit, "person-1");
  audit.close();

  const nextAudit = createAudit();
  expectUnknown(stale);
  expectUnknown({ kind: "channel-admission-evidence" } as ChannelAdmissionEvidence);
  expect(inspect(await admittedContext(nextAudit, "person-1"))).toMatchObject({
    ingressState: "present",
  });

  expect(await evidenceFor(audit, "person-1")).toBeUndefined();
});

it.each(["unsupported", "omitted", "fake", "public", "ownerless"] as const)(
  "keeps %s adapter handoffs non-authoritative",
  async (kind) => {
    const owner = createOwner(createAudit());
    const base = makeContext("person-1", "msg-1");
    const ingress = await createHostChannelIngressRuntime(owner).resolveStable(ingressInput(base));
    const handoffs = {
      unsupported: "unsupported" as const,
      omitted: undefined,
      fake: { ...ingress },
      public: ingress,
      ownerless: ingress,
    };
    const build =
      kind === "public" ? buildChannelInboundEventContext : buildHostChannelInboundEventContext;
    const context = build({ ...base, channelIngress: handoffs[kind] });
    if (kind === "public") {
      expect(readEvidence(context)).toBeUndefined();
    } else {
      expect(inspect(context)).toMatchObject(
        kind === "unsupported"
          ? { ingressState: "unsupported", decisionCoverage: "unsupported" }
          : unknownEvidence,
      );
    }
  },
);

it("expires a carrier at the bounded retention edge", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const audit = createAudit();
  const evidence = await evidenceFor(audit, "person-1");
  vi.setSystemTime(1_000 + 30 * 24 * 60 * 60_000 + 1);
  expectUnknown(evidence);
});

it("bounds aggregate fan-in and participant material", async () => {
  const audit = createAudit();
  const oversizedParticipant = await evidenceFor(audit, "x".repeat(4_097));
  expectUnknown(oversizedParticipant);

  const sources = await Promise.all(
    Array.from({ length: 17 }, (_, index) => evidenceFor(audit, `person-${index}`)),
  );
  expectUnknown(combineEvidence(sources));
});
