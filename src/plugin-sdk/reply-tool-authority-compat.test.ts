import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptParamsV2,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  NativeSessionBindingAuthority,
  NativeSessionBindingWithCurrent,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { controlRealtimeVoiceAgentRun } from "openclaw/plugin-sdk/realtime-voice";
import { expectTypeOf, it } from "vitest";

type Operation = NonNullable<EmbeddedRunAttemptParamsV2["replyOperation"]>;
type Snapshot = Parameters<Operation["bindToolAuthoritySnapshot"]>[0];
type Overlay = Parameters<Operation["projectToolAuthorityFingerprint"]>[0];
type Route = Readonly<{ provider: string; model: string }>;
type Injection = NonNullable<Parameters<Operation["attachBackend"]>[0]["messageInjectionV2"]>;
type Options = Parameters<Injection["queueMessage"]>[1];
type Kind = "run" | "source-bound";
type QueueResult = void | { transcriptCommit: "unconfirmed"; errorMessage: string };
type Preparation = {
  assertCurrent(this: void): void;
  prepareCurrent(this: void): Promise<void>;
  compatAssertCurrent(this: void): void;
};

it("preserves v2026.9.8 synchronous reply operations and two-method snapshot literals", () => {
  type ReleasedSnapshot = {
    fingerprint: (route?: Route) => string;
    project: (overlay: Overlay, route: Route) => string;
  };
  type ReleasedOperation = {
    bindToolAuthoritySnapshot: (snapshot: ReleasedSnapshot) => void;
    projectToolAuthorityFingerprint: (overlay: Overlay) => string | undefined;
    bindToolAuthorityRoute: (route: Route) => string;
  };
  expectTypeOf<
    NonNullable<AgentHarnessAttemptParamsV2["replyOperation"]>
  >().toEqualTypeOf<Operation>();
  expectTypeOf<
    NonNullable<AgentHarnessAttemptParams["replyOperation"]>
  >().toEqualTypeOf<Operation>();
  expectTypeOf<
    NonNullable<EmbeddedRunAttemptParams["replyOperation"]>
  >().toEqualTypeOf<Operation>();
  expectTypeOf<ReleasedSnapshot>().toExtend<Snapshot>();
  expectTypeOf<Operation>().toExtend<ReleasedOperation>();
  expectTypeOf<Operation["bindToolAuthoritySnapshot"]>().returns.toEqualTypeOf<void>();
  expectTypeOf<Operation["projectToolAuthorityFingerprint"]>().returns.toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Operation["bindToolAuthorityRoute"]>().returns.toEqualTypeOf<string>();
  expectTypeOf<Operation["bindToolAuthoritySnapshotAsync"]>().returns.toEqualTypeOf<
    Promise<void>
  >();
  expectTypeOf<Operation["projectToolAuthorityFingerprintAsync"]>().returns.toEqualTypeOf<
    Promise<string | undefined>
  >();
  expectTypeOf<Operation["bindToolAuthorityRouteAsync"]>().returns.toEqualTypeOf<Promise<string>>();
  expectTypeOf<NonNullable<Snapshot["fingerprintAsync"]>>().toEqualTypeOf<
    (route?: Route) => Promise<string>
  >();
  expectTypeOf<NonNullable<Snapshot["projectAsync"]>>().toEqualTypeOf<
    (overlay: Overlay, route: Route) => Promise<string>
  >();
});

it("accepts released V2 injection implementations alongside the prepared queue companion", () => {
  type ReleasedInjection = {
    version: 2;
    isAvailable: () => boolean;
    queueMessage: (
      text: string,
      options: Options,
      assertCurrent: () => void,
      kind: Kind,
    ) => Promise<QueueResult>;
    claimPendingUserInputAnswer?: (
      text: string,
      options: Options,
      assertCurrent: () => void,
      kind: Kind,
    ) => Promise<boolean>;
    cancelPendingUserInput?: (
      resolvedBy: string,
      assertCurrent: () => void,
      kind: Kind,
    ) => Promise<boolean>;
  };
  expectTypeOf<ReleasedInjection>().toExtend<Injection>();
  expectTypeOf<Injection>().toExtend<ReleasedInjection>();
  expectTypeOf<NonNullable<Injection["queueMessageAsync"]>>().toEqualTypeOf<
    (text: string, options: Options, preparation: Preparation, kind: Kind) => Promise<QueueResult>
  >();
});

it("keeps native withCurrent implementations valid alongside optional policy composition", () => {
  type ReleasedAuthority = Omit<NativeSessionBindingAuthority, "withPreparedCurrent">;
  expectTypeOf<ReleasedAuthority>().toExtend<NativeSessionBindingAuthority>();
  expectTypeOf<
    NativeSessionBindingAuthority["withCurrent"]
  >().toEqualTypeOf<NativeSessionBindingWithCurrent>();
  expectTypeOf<NonNullable<NativeSessionBindingAuthority["withPreparedCurrent"]>>().toEqualTypeOf<
    <T>(
      consume: () => T,
      preparations: readonly (Preparation & { onRefused?: (error: unknown) => "discarded" })[],
    ) => Promise<T>
  >();
});

it("accepts released realtime voice guarded queue adapters without preparation options", () => {
  type Dependencies = NonNullable<Parameters<typeof controlRealtimeVoiceAgentRun>[1]>;
  type Queue = NonNullable<Dependencies["queueGuardedEmbeddedAgentMessageWithOutcomeAsync"]>;
  type ReleasedOptions = Omit<
    NonNullable<Parameters<Queue>[2]>,
    "canAdmit" | "toolAuthorityPreparation"
  >;
  type ReleasedQueue = (
    sessionId: string,
    text: string,
    options: ReleasedOptions | undefined,
    canInject: () => boolean,
  ) => ReturnType<Queue>;
  expectTypeOf<ReleasedQueue>().toExtend<Queue>();
});
