import { describe, expect, it, vi } from "vitest";
import {
  fanInChannelIngressLifecycles,
  meetsIdentifierAuthentication,
  resolveChannelMessageIngress,
  type ChannelIngressIdentityDescriptor,
  type IdentifierAuthentication,
  type ResolveChannelMessageIngressParams,
} from "./channel-ingress-runtime.js";

type FanInLifecycle = NonNullable<Parameters<typeof fanInChannelIngressLifecycles>[0][number]>;

function createLifecycle() {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
  };
}

function createCancellableLifecycle() {
  return {
    ...createLifecycle(),
    onFailed: vi.fn<NonNullable<FanInLifecycle["onFailed"]>>(async () => {}),
    onCancelled: vi.fn(async () => {}),
  };
}

const identity = {
  primary: { normalize: (value) => value.trim().toLowerCase(), sensitivity: "pii" },
} satisfies ChannelIngressIdentityDescriptor;
const command = { useAccessGroups: true, allowTextCommands: true, hasControlCommand: true };
const normalize = (value: string) => value.trim().toLowerCase();
const normalizeUser = (value: string) => normalize(value).replace(/^users\//, "");

async function resolve(input: Partial<ResolveChannelMessageIngressParams> = {}) {
  return await resolveChannelMessageIngress({
    channelId: "runtime-test",
    accountId: "default",
    identity,
    subject: { stableId: "owner" },
    conversation: { kind: "direct", id: "dm-1" },
    event: { kind: "message", authMode: "inbound", mayPair: true },
    policy: { dmPolicy: "allowlist", groupPolicy: "disabled", ...input.policy },
    allowFrom: ["owner"],
    ...input,
  });
}

describe("plugin-sdk/channel-ingress-runtime", () => {
  it("compares typed identifier claims through the public SDK", () => {
    const minimum: IdentifierAuthentication = "asserted";
    const subject = {
      email: "verified",
      displayName: "mutable",
    } satisfies NonNullable<ResolveChannelMessageIngressParams["subject"]["authentication"]>;

    expect(meetsIdentifierAuthentication(subject.email, minimum)).toBe(true);
    expect(meetsIdentifierAuthentication(subject.displayName, minimum)).toBe(false);
  });

  it("fans one logical turn lifecycle across every durable claim", async () => {
    const first = { ...createCancellableLifecycle(), deferredHeartbeatIntervalMs: 3_000 };
    const second = { ...createCancellableLifecycle(), deferredHeartbeatIntervalMs: 1_000 };
    const cancellation = fanInChannelIngressLifecycles([first, second]);
    await cancellation.lifecycle?.onCancelled?.();
    const combined = fanInChannelIngressLifecycles([undefined, first, second]);

    expect(combined.lifecycle?.deferredHeartbeatIntervalMs).toBe(1_000);

    combined.lifecycle?.onAdoptionFinalizing();
    await combined.lifecycle?.onAdopted();
    await combined.settle();

    for (const source of [first, second]) {
      expect(source.onAdoptionFinalizing).toHaveBeenCalledOnce();
      expect(source.onAdopted).toHaveBeenCalledOnce();
      expect(source.onAbandoned).not.toHaveBeenCalled();
      expect(source.onCancelled).toHaveBeenCalledOnce();
    }
  });

  it("settles or abandons claims that no reply lane adopted", async () => {
    const lifecycle = { ...createLifecycle(), onFailed: vi.fn(async () => {}) };

    await fanInChannelIngressLifecycles([lifecycle]).settle();
    await fanInChannelIngressLifecycles([lifecycle]).abandon();

    expect(lifecycle.onAdopted).toHaveBeenCalledOnce();
    expect(lifecycle.onAbandoned).toHaveBeenCalledOnce();
    expect(lifecycle.onFailed).not.toHaveBeenCalled();
    expect(fanInChannelIngressLifecycles([]).lifecycle).toBeUndefined();
  });

  it("cancellation-settles every source in mixed capable and legacy fan-in", async () => {
    const modern = createCancellableLifecycle();
    const legacy = { ...createLifecycle(), onFailed: vi.fn(async () => {}) };
    const combined = fanInChannelIngressLifecycles([modern, legacy]);

    expect(combined.lifecycle).not.toHaveProperty("onCancelled");
    await combined.cancel();

    expect(modern.onAdopted).not.toHaveBeenCalled();
    expect(legacy.onAdopted).not.toHaveBeenCalled();
    expect(modern.onCancelled).toHaveBeenCalledOnce();
    expect(legacy.onAbandoned).toHaveBeenCalledOnce();
  });

  it("preserves lifecycle receivers while fanning in cancellation", async () => {
    const withReceiver = () => ({
      ...createCancellableLifecycle(),
      cancellationCount: 0,
      async onCancelled() {
        this.cancellationCount += 1;
      },
    });
    const first = withReceiver();
    const second = withReceiver();

    await fanInChannelIngressLifecycles([first, second]).lifecycle?.onCancelled?.();

    expect(first.cancellationCount).toBe(1);
    expect(second.cancellationCount).toBe(1);
  });

  it.each(["settle", "lifecycle"] as const)(
    "settles rejected adoption once through %s",
    async (surface) => {
      const failed = vi.fn<NonNullable<FanInLifecycle["onFailed"]>>(async () => {});
      const abandoned = vi.fn(async () => {});
      const legacyAbandoned = vi.fn(async () => {});
      const first = {
        ...createLifecycle(),
        onAbandoned: abandoned,
        onAdopted: async () => {
          throw new Error("adoption failed");
        },
        ...(surface === "settle" ? { onFailed: failed } : {}),
      };
      const combined = fanInChannelIngressLifecycles(
        surface === "settle"
          ? [first, { ...createLifecycle(), onAbandoned: legacyAbandoned }]
          : [first],
      );
      await expect(
        surface === "settle" ? combined.settle() : combined.lifecycle?.onAdopted(),
      ).rejects.toThrow("adoption failed");
      if (surface === "settle") {
        await combined.abandon(new Error("dispatch failed"));
        expect(failed).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "adoption failed" }),
        );
        expect(abandoned).not.toHaveBeenCalled();
        expect(legacyAbandoned).toHaveBeenCalledOnce();
      } else {
        // Wrappers abandon through the lifecycle; that must not consume a second retry.
        await combined.lifecycle?.onAbandoned();
        expect(abandoned).toHaveBeenCalledOnce();
      }
    },
  );

  it("releases the claims a rejected adoption never reached", async () => {
    const order: string[] = [];
    const lifecycleFor = (name: string, onAdopted: () => Promise<void>) => ({
      ...createLifecycle(),
      onAdopted,
      onFailed: vi.fn(async () => {
        order.push(`failed:${name}`);
      }),
      onAbandoned: vi.fn(async () => {
        order.push(`abandoned:${name}`);
      }),
    });
    const first = lifecycleFor("first", async () => {
      order.push("adopted:first");
    });
    const second = lifecycleFor("second", async () => {
      throw new Error("claim reclaimed");
    });
    const third = lifecycleFor("third", async () => {
      order.push("adopted:third");
    });
    const combined = fanInChannelIngressLifecycles([first, second, third]);

    await expect(combined.lifecycle?.onAdopted()).rejects.toThrow("claim reclaimed");
    // The delivery catch abandons after a failed handoff; every claim must
    // already carry a disposition by then rather than wait for recovery.
    await combined.abandon(new Error("delivery failed"));

    expect(order).toEqual(["adopted:first", "failed:second", "failed:third"]);
    expect(first.onFailed).not.toHaveBeenCalled();
    expect(first.onAbandoned).not.toHaveBeenCalled();
  });

  it("derives store allowlists, command auth, sender separation, and redaction", async () => {
    const sender = "Secret-Sender@example.test";
    const readStoreAllowFrom = vi.fn(async () => ["secret-sender@example.test"]);
    const allowed = await resolve({
      subject: { stableId: sender },
      policy: { dmPolicy: "pairing", groupPolicy: "disabled" },
      allowFrom: [],
      readStoreAllowFrom,
      command,
    });
    expect(readStoreAllowFrom).toHaveBeenCalledOnce();
    expect(allowed).toMatchObject({
      ingress: { admission: "dispatch", decision: "allow" },
      commandAccess: { authorized: true },
    });
    expect(JSON.stringify(allowed.state)).not.toContain(sender);
    expect(JSON.stringify(allowed.ingress)).not.toContain(sender);

    const blockedBeforeCommand = await resolve({
      route: { id: "route:disabled", enabled: false },
      command,
    });
    expect(blockedBeforeCommand.ingress.reasonCode).toBe("route_blocked");
    expect(blockedBeforeCommand.commandAccess.authorized).toBe(false);

    const unauthorizedCommand = await resolve({
      conversation: { kind: "group", id: "room-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "open",
        groupAllowFromFallbackToAllowFrom: false,
      },
      command: {
        ...command,
        groupOwnerAllowFrom: "none",
        commandGroupAllowFromFallbackToAllowFrom: false,
      },
    });
    expect(unauthorizedCommand).toMatchObject({
      ingress: { reasonCode: "control_command_unauthorized" },
      senderAccess: { decision: "allow", reasonCode: "group_policy_open" },
      commandAccess: { shouldBlockControlCommand: true },
    });
  });

  it("keeps normalized compatibility entries scoped to the intended identifier kind", async () => {
    const prefixedIdentity = {
      primary: {
        key: "user-id",
        normalizeEntry: (value) => normalizeUser(value) || null,
        normalizeSubject: normalizeUser,
      },
      aliases: [
        {
          key: "email",
          kind: "plugin:test-email",
          normalizeEntry(value) {
            const normalized = value.trim().toLowerCase();
            return normalized.startsWith("users/") || !normalized.includes("@") ? null : normalized;
          },
          normalizeSubject: normalize,
          dangerous: true,
        },
      ],
    } satisfies ChannelIngressIdentityDescriptor;

    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity: prefixedIdentity,
      subject: { stableId: "users/123", aliases: { email: "jane@example.test" } },
      conversation: { kind: "direct", id: "dm-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "allowlist",
        groupPolicy: "disabled",
        mutableIdentifierMatching: "enabled",
      },
      allowFrom: ["users/jane@example.test"],
    });

    expect(result.senderAccess.effectiveAllowFrom).toEqual(["jane@example.test"]);
    expect(result.senderAccess.decision).toBe("block");
  });
});
