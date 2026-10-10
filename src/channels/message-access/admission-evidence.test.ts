import { describe, expect, it, vi } from "vitest";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../../gateway/server-methods/types.js";
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
import { createHostChannelIngressRuntime, resolveStableChannelIngressPolicy } from "./runtime.js";

async function buildAdmittedContext(
  audit: ChannelAdmissionAudit,
  participantId: string,
  allowFrom = [participantId],
  resolveGatewayContext?: GatewayContextResolver,
  authentication?: "verified" | "asserted" | "unverified" | "mutable",
) {
  const gateway = {
    channelAdmissionAudit: audit,
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
  const owner = {
    channelId: "test",
    isLive: () => true,
    resolveGatewayContext: resolveGatewayContext ?? (() => gateway),
  };
  const channelIngress = await createHostChannelIngressRuntime(owner).resolveStable({
    channelId: "test",
    accountId: "acct:primary",
    identity: authentication ? { authentication: "verified" } : undefined,
    subject: {
      stableId: participantId,
      ...(authentication ? { authentication: { stableId: authentication } } : {}),
    },
    conversation: { kind: "direct", id: "dm-1" },
    contextBinding: {
      agentId: "main",
      sessionKey: "agent:main:test:dm:dm-1",
      messageId: "msg-1",
      inboundEventKind: "user_request",
    },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    ...(authentication ? { policy: { minIdentifierAuthentication: "unverified" } } : {}),
    allowFrom,
  });
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  return buildContext({
    channel: "test",
    accountId: "acct:primary",
    messageId: "msg-1",
    from: "test:route:dm-1",
    sender: { id: participantId },
    conversation: { kind: "direct", id: "dm-1" },
    route: { agentId: "main", routeSessionKey: "agent:main:test:dm:dm-1" },
    reply: { to: "test:route:dm-1" },
    message: { rawBody: "hello" },
    channelIngress,
  });
}

function inspectChannelContext(context: object) {
  return consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context));
}

describe("channel admission evidence", () => {
  it("keeps Gateway routing instance-bound when audit collection is disabled", async () => {
    const audit = createChannelAdmissionAudit({ enabled: false });
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
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const context = await buildAdmittedContext(audit, "person:42");
      const evidence = readChannelContextAdmissionEvidence(context);
      const consumed = consumeChannelAdmissionEvidence(evidence);

      expect(consumed).toEqual({
        ingressState: "present",
        invoker: {
          state: "present",
          kind: "person",
          rawPrincipalRef: '["test","acct:primary","person:42"]',
        },
        assuranceRef: "channel-admission",
        decisionCoverage: "enforced",
        identifierAuthentication: "evaluated",
      });
      expect(Object.isFrozen(consumed)).toBe(true);
      expect(Object.isFrozen(consumed.invoker)).toBe(true);
      expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
        decisionCoverage: "unknown",
      });
    } finally {
      audit.close();
    }
  });

  it("rejects implicit context custody transfer and forged private carriers", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const source = await buildAdmittedContext(audit, "person-a");
      const copiedDescriptors = Object.defineProperties(
        {},
        Object.getOwnPropertyDescriptors(source),
      );
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
        expect(inspectChannelContext(candidate)).toMatchObject({ ingressState: "unknown" });
      }
      expect(forgedResolver).not.toHaveBeenCalled();
      expect(inspectChannelContext(source)).toMatchObject({ ingressState: "present" });
    } finally {
      audit.close();
    }
  });

  it("carries only the redacted identifier-policy explanation through host-owned evidence", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const context = await buildAdmittedContext(
        audit,
        "private-person",
        ["private-person"],
        undefined,
        "unverified",
      );
      const consumed = inspectChannelContext(context);

      expect(consumed).toMatchObject({
        ingressState: "present",
        identifierAuthentication: "evaluated",
      });
    } finally {
      audit.close();
    }
  });

  it("rejects copying one participant carrier onto another participant context", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const source = await buildAdmittedContext(audit, "person-a");
      const target = { ...source, SenderId: "person-b" };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(target)),
      ).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      audit.close();
    }
  });

  it("cannot bootstrap evidence through the public copy helper", () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const source = { OriginatingChannel: "test", AccountId: "default", SenderId: "person-a" };
      const target = { ...source };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(readChannelContextAdmissionEvidence(target)).toBeUndefined();
    } finally {
      audit.close();
    }
  });

  it.each(["unchanged", "unreadable"])(
    "copies admission only across a readable %s scope",
    async (scope) => {
      const audit = createChannelAdmissionAudit({ enabled: true });
      try {
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
          invoker:
            scope === "unchanged" ? { state: "present", kind: "person" } : { state: "unknown" },
        });
        if (scope === "unreadable") {
          expect(readChannelContextGatewayContextResolver(target)).toBeUndefined();
        }
      } finally {
        audit.close();
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
    ["route", { SessionKey: "agent:other:test:dm:dm-1" }],
    ["thread", { MessageThreadId: "thread-2" }],
    ["native channel", { NativeChannelId: "native-2" }],
    ["message", { MessageSid: "msg-2", MessageSidFull: "msg-2" }],
  ])("degrades a carrier copied across changed %s scope", async (_name, patch) => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const source = await buildAdmittedContext(audit, "person-a");
      const target = { ...source, ...patch };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(inspectChannelContext(target)).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      audit.close();
    }
  });

  it("cannot revive a carrier through a same-scope copy after run admission", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const source = await buildAdmittedContext(audit, "person-a");
      expect(inspectChannelContext(source)).toMatchObject({ ingressState: "present" });
      const target = { ...source };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(inspectChannelContext(target)).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      audit.close();
    }
  });

  it("reports same-participant collection while mixed participants fail closed", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const first = readChannelContextAdmissionEvidence(await buildAdmittedContext(audit, "c"));
      const same = readChannelContextAdmissionEvidence(await buildAdmittedContext(audit, "c"));
      const tupleCollisionCandidate = readChannelContextAdmissionEvidence(
        await buildAdmittedContext(audit, "b:c"),
      );

      expect(
        consumeChannelAdmissionEvidence(combineChannelAdmissionEvidence([first, same])),
      ).toEqual({
        ingressState: "present",
        invoker: {
          state: "present",
          kind: "person",
          rawPrincipalRef: '["test","acct:primary","c"]',
        },
        assuranceRef: "channel-admission",
        decisionCoverage: "enforced",
        identifierAuthentication: "evaluated",
      });
      expect(
        consumeChannelAdmissionEvidence(
          combineChannelAdmissionEvidence([
            readChannelContextAdmissionEvidence(await buildAdmittedContext(audit, "c")),
            tupleCollisionCandidate,
          ]),
        ),
      ).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
        decisionCoverage: "unknown",
      });
    } finally {
      audit.close();
    }
  });

  it("keeps wildcard admission attribution-only because identity did not affect the outcome", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const context = await buildAdmittedContext(audit, "person-42", ["*"]);
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context)),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
        decisionCoverage: "attribution-only",
      });
    } finally {
      audit.close();
    }
  });

  it("rejects forged and prior-lifecycle carriers and stays empty when collection is disabled", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    const stale = readChannelContextAdmissionEvidence(
      await buildAdmittedContext(audit, "person-1"),
    );
    audit.close();

    const nextAudit = createChannelAdmissionAudit({ enabled: true });
    try {
      expect(consumeChannelAdmissionEvidence(stale)).toMatchObject({ ingressState: "unknown" });
      expect(
        consumeChannelAdmissionEvidence({
          kind: "channel-admission-evidence",
        } as ChannelAdmissionEvidence),
      ).toMatchObject({ ingressState: "unknown" });
      expect(
        inspectChannelContext(await buildAdmittedContext(nextAudit, "person-1")),
      ).toMatchObject({
        ingressState: "present",
      });
    } finally {
      nextAudit.close();
    }

    expect(
      readChannelContextAdmissionEvidence(await buildAdmittedContext(audit, "person-1")),
    ).toBeUndefined();
  });

  it("distinguishes unsupported, omitted, and structurally fake adapter handoffs", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const base = {
        channel: "legacy",
        accountId: "default",
        messageId: "msg-1",
        from: "legacy:route:room-1",
        sender: { id: "person-1" },
        conversation: { kind: "direct" as const, id: "room-1" },
        route: { agentId: "main", routeSessionKey: "agent:main:legacy:dm:room-1" },
        reply: { to: "legacy:route:room-1" },
        message: { rawBody: "hello" },
      };
      const unsupported = buildHostChannelInboundEventContext({
        ...base,
        channelIngress: "unsupported",
      });
      const omitted = buildHostChannelInboundEventContext(base);
      const exact = await resolveStableChannelIngressPolicy({
        channelId: "legacy",
        accountId: "default",
        subject: { stableId: "person-1" },
        conversation: { kind: "direct", id: "room-1" },
        contextBinding: {
          agentId: "main",
          sessionKey: "agent:main:legacy:dm:room-1",
          messageId: "msg-1",
          inboundEventKind: "user_request",
        },
        dmPolicy: "open",
      });
      const mismatched = buildHostChannelInboundEventContext({
        ...base,
        channelIngress: { ...exact },
      });

      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(unsupported)),
      ).toMatchObject({ ingressState: "unsupported", decisionCoverage: "unsupported" });
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(omitted)),
      ).toMatchObject({
        ingressState: "unknown",
        decisionCoverage: "unknown",
      });
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(mismatched)),
      ).toMatchObject({ ingressState: "unknown", decisionCoverage: "unknown" });
    } finally {
      audit.close();
    }
  });

  it("keeps ordinary public and ownerless host builders non-authoritative", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    const gateway = {
      channelAdmissionAudit: audit,
      getRuntimeConfig: () => ({}),
    } as GatewayRequestContext;
    const owner = {
      channelId: "public-test",
      isLive: () => true,
      resolveGatewayContext: () => gateway,
    };
    try {
      const ingress = await createHostChannelIngressRuntime(owner).resolveStable({
        channelId: "public-test",
        accountId: "default",
        subject: { stableId: "person-1" },
        conversation: { kind: "direct", id: "dm-1" },
        contextBinding: {
          agentId: "main",
          sessionKey: "agent:main:public-test:dm:dm-1",
          inboundEventKind: "user_request",
        },
        dmPolicy: "open",
      });
      const params = {
        channel: "public-test",
        accountId: "default",
        from: "public-test:dm-1",
        sender: { id: "person-1" },
        conversation: { kind: "direct" as const, id: "dm-1" },
        route: { agentId: "main", routeSessionKey: "agent:main:public-test:dm:dm-1" },
        reply: { to: "public-test:dm-1" },
        message: { rawBody: "hello" },
        channelIngress: ingress,
      };

      const publicContext = buildChannelInboundEventContext(params);
      expect(readChannelContextAdmissionEvidence(publicContext)).toBeUndefined();
      const ownerlessContext = buildHostChannelInboundEventContext(params);
      expect(inspectChannelContext(ownerlessContext)).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      audit.close();
    }
  });

  it("expires a carrier at the bounded retention edge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const evidence = readChannelContextAdmissionEvidence(
        await buildAdmittedContext(audit, "person-1"),
      );
      vi.setSystemTime(1_000 + 30 * 24 * 60 * 60_000 + 1);
      expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
        ingressState: "unknown",
        decisionCoverage: "unknown",
      });
    } finally {
      audit.close();
      vi.useRealTimers();
    }
  });

  it("bounds aggregate fan-in and participant material", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const oversizedParticipant = readChannelContextAdmissionEvidence(
        await buildAdmittedContext(audit, "x".repeat(4_097)),
      );
      expect(consumeChannelAdmissionEvidence(oversizedParticipant)).toMatchObject({
        ingressState: "unknown",
      });

      const sources = await Promise.all(
        Array.from({ length: 17 }, async (_, index) =>
          readChannelContextAdmissionEvidence(await buildAdmittedContext(audit, `person-${index}`)),
        ),
      );
      expect(
        consumeChannelAdmissionEvidence(combineChannelAdmissionEvidence(sources)),
      ).toMatchObject({
        ingressState: "unknown",
      });
    } finally {
      audit.close();
    }
  });
});
