import { afterEach, expect, it, vi } from "vitest";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  buildChannelInboundEventContext,
  buildHostChannelInboundEventContext,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import { publicResultScopeKey } from "./admission-evidence-scope-key.js";
import {
  combineChannelAdmissionEvidence,
  createChannelAdmissionAudit,
  type ChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
  copyChannelParticipantAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  readChannelContextGatewayContextResolver,
  type ChannelAdmissionEvidence,
} from "./admission-evidence.js";
import {
  createHostIngressFixture,
  ingressInput as hostIngressInput,
  ingressMessage,
} from "./host-ingress.test-support.js";
import type { ResolveStableChannelMessageIngressParams } from "./runtime-types.js";
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
    from: "test:route:dm-1",
    conversation: { kind: "direct", id: "dm-1" },
    reply: { to: "test:route:dm-1" },
  });
}
function ingressInput(
  params: ReturnType<typeof makeContext>,
  overrides: Partial<ResolveStableChannelMessageIngressParams> = {},
): ResolveStableChannelMessageIngressParams {
  return hostIngressInput(params, {
    groupPolicy: undefined,
    allowFrom: undefined,
    useDefaultPairingStore: undefined,
    ...overrides,
  });
}

function createOwner(audit: ChannelAdmissionAudit, resolveGatewayContext?: GatewayContextResolver) {
  const { owner } = createHostIngressFixture("test", {}, { channelAdmissionAudit: audit });
  return resolveGatewayContext ? { ...owner, resolveGatewayContext } : owner;
}

async function buildAdmittedContext(
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
  return readChannelContextAdmissionEvidence(await buildAdmittedContext(audit, participantId));
}

function inspectChannelContext(context: object) {
  return consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context));
}
function expectUnknown(evidence: ChannelAdmissionEvidence | undefined) {
  expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject(unknownEvidence);
}

it("keeps Gateway routing instance-bound when audit collection is disabled", async () => {
  const audit = createAudit(false);
  const gatewayContext = { owner: "gateway-a" } as never;
  let live = true;
  const source = await buildAdmittedContext(audit, "person:42", ["person:42"], () =>
    live ? gatewayContext : undefined,
  );
  const copied = { ...source };

  copyChannelParticipantAdmissionEvidence(source, copied);

  expect(readChannelContextGatewayContextResolver(source)?.()).toBe(gatewayContext);
  expect(readChannelContextGatewayContextResolver(copied)?.()).toBe(gatewayContext);
  live = false;
  expect(readChannelContextGatewayContextResolver(source)?.()).toBeUndefined();
});

it("carries the resolver participant to one run admission without route inference", async () => {
  const context = await buildAdmittedContext(createAudit(), "person:42");
  const evidence = readChannelContextAdmissionEvidence(context);
  const consumed = consumeChannelAdmissionEvidence(evidence);

  expect(consumed).toEqual(admittedEvidence("person:42"));
  expect([Object.isFrozen(consumed), Object.isFrozen(consumed.invoker)]).toEqual([true, true]);
  expectUnknown(evidence);
});

it("rejects implicit context custody transfer and forged private carriers", async () => {
  const source = await buildAdmittedContext(createAudit(), "person-a");
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
    expect(readChannelContextGatewayContextResolver(candidate)).toBeUndefined();
    expect(inspectChannelContext(candidate)).toMatchObject(unknownEvidence);
  }
  expect(forgedResolver).not.toHaveBeenCalled();
  expect(inspectChannelContext(source)).toMatchObject({ ingressState: "present" });
});

it("cannot bootstrap evidence through the public copy helper", () => {
  const source = { OriginatingChannel: "test", AccountId: "default", SenderId: "person-a" };
  const target = { ...source };

  copyChannelParticipantAdmissionEvidence(source, target);

  expect(readChannelContextAdmissionEvidence(target)).toBeUndefined();
});

it.each(["unchanged", "unreadable"])(
  "copies admission only across a readable %s scope",
  async (scope) => {
    const audit = createAudit();
    const source = await buildAdmittedContext(audit, "person-a");
    const target = new Proxy(
      { ...source },
      {
        getOwnPropertyDescriptor(value, key) {
          if (scope === "unreadable" && key === "NativeDirectUserId") {
            throw new Error("scope unavailable");
          }
          return Reflect.getOwnPropertyDescriptor(value, key);
        },
      },
    );

    copyChannelParticipantAdmissionEvidence(source, target);

    expect(inspectChannelContext(target)).toMatchObject({
      ingressState: scope === "unchanged" ? "present" : "unknown",
      invoker: scope === "unchanged" ? { state: "present", kind: "person" } : { state: "unknown" },
    });
    if (scope === "unreadable") {
      expect(readChannelContextGatewayContextResolver(target)).toBeUndefined();
    }
  },
);

it("rejects an event whose symbol descriptor becomes unreadable without throwing", async () => {
  const result = await resolveStableChannelIngressPolicy({
    channelId: "test",
    accountId: "default",
    subject: { stableId: "person-1" },
    conversation: { kind: "direct", id: "dm-1" },
    dmPolicy: "open",
  });
  const key = Symbol("unreadable-event-field");
  let reads = 0;
  result.state.event = new Proxy(
    { ...result.state.event, [key]: true },
    {
      getOwnPropertyDescriptor(value, property) {
        if (property === key && ++reads > 1) {
          throw new Error("event field unavailable");
        }
        return Reflect.getOwnPropertyDescriptor(value, property);
      },
    },
  );
  expect(publicResultScopeKey(result)).toBeUndefined();
});

it.each([
  ["consumed", {}],
  ["participant", { SenderId: "person-b" }],
  ["route", { SessionKey: "agent:other:test:dm:dm-1" }],
  ["thread", { MessageThreadId: "thread-2" }],
  ["native channel", { NativeChannelId: "native-2" }],
  ["message", { MessageSid: "msg-2", MessageSidFull: "msg-2" }],
])("rejects %s carrier copies", async (kind, patch) => {
  const source = await buildAdmittedContext(createAudit(), "person-a");
  if (kind === "consumed") {
    expect(inspectChannelContext(source)).toMatchObject({ ingressState: "present" });
  }
  const target = { ...source, ...patch };

  copyChannelParticipantAdmissionEvidence(source, target);

  expect(inspectChannelContext(target)).toMatchObject(unknownEvidence);
});

it("reports same-participant collection while mixed participants fail closed", async () => {
  const audit = createAudit();
  const combined = async (...participants: string[]) =>
    combineChannelAdmissionEvidence(
      await Promise.all(participants.map((id) => evidenceFor(audit, id))),
    );
  expect(consumeChannelAdmissionEvidence(await combined("c", "c"))).toEqual(admittedEvidence("c"));
  expectUnknown(await combined("c", "b:c"));
});

it("keeps wildcard admission attribution-only because identity did not affect the outcome", async () => {
  const context = await buildAdmittedContext(createAudit(), "person-42", ["*"]);
  expect(inspectChannelContext(context)).toMatchObject({
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
  expect(inspectChannelContext(await buildAdmittedContext(nextAudit, "person-1"))).toMatchObject({
    ingressState: "present",
  });

  expect(await evidenceFor(audit, "person-1")).toBeUndefined();
});

it("distinguishes unsupported, omitted, and structurally fake adapter handoffs", async () => {
  const base = makeContext("person-1", "msg-1");
  const unsupported = buildHostChannelInboundEventContext({
    ...base,
    channelIngress: "unsupported",
  });
  const omitted = buildHostChannelInboundEventContext(base);
  const exact = await resolveStableChannelIngressPolicy(ingressInput(base));
  const mismatched = buildHostChannelInboundEventContext({
    ...base,
    channelIngress: { ...exact },
  });

  expect(inspectChannelContext(unsupported)).toMatchObject({
    ingressState: "unsupported",
    decisionCoverage: "unsupported",
  });
  expect(inspectChannelContext(omitted)).toMatchObject(unknownEvidence);
  expect(inspectChannelContext(mismatched)).toMatchObject(unknownEvidence);
});

it("keeps ordinary public and ownerless host builders non-authoritative", async () => {
  const audit = createAudit();
  const owner = createOwner(audit);
  const base = makeContext("person-1");
  const ingress = await createHostChannelIngressRuntime(owner).resolveStable(ingressInput(base));
  const params = { ...base, channelIngress: ingress };

  const publicContext = buildChannelInboundEventContext(params);
  expect(readChannelContextAdmissionEvidence(publicContext)).toBeUndefined();
  const ownerlessContext = buildHostChannelInboundEventContext(params);
  expect(inspectChannelContext(ownerlessContext)).toMatchObject(unknownEvidence);
});

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
    Array.from({ length: 17 }, async (_, index) => await evidenceFor(audit, `person-${index}`)),
  );
  expectUnknown(combineChannelAdmissionEvidence(sources));
});
