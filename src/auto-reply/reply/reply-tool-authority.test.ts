import { afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import type { GatewayAccessGrantRef } from "../../plugins/gateway-access-policy.types.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import type { ReplyBackendQueueMessageOptions } from "../../sessions/session-controller.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage,
} from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import {
  createQueueTestRun,
  resolveFollowupRunToolAuthorityFingerprintAsync as fingerprintFor,
  toolAuthorityOverlay,
} from "./reply-tool-authority.test-support.js";

const rejected = { status: "rejected", reason: "tool_authority_mismatch" } as const;

async function admit(
  run: ReturnType<typeof createQueueTestRun>,
  sessionId: string,
  route = { provider: run.run.provider, model: run.run.model },
  isStreaming?: () => boolean,
) {
  const operation = createTestReplyOperation({ sessionId });
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
  const fingerprint = await operation.bindToolAuthorityRouteAsync(route);
  const queueMessage = vi.fn(
    async (_text: string, _options?: ReplyBackendQueueMessageOptions) => {},
  );
  operation.attachBackend({
    kind: "embedded",
    cancel: vi.fn(),
    queueMessage,
    ...(isStreaming ? { isStreaming } : {}),
  });
  operation.setPhase("running");
  const inject = (
    overlay?: ReplyToolAuthorityOverlay,
    options: Parameters<typeof queueCurrentReplyRunMessage>[2] = {},
  ) =>
    queueCurrentReplyRunMessage(sessionId, "change strategy", {
      isInboundUserMessage: true,
      toolAuthorityOverlay: overlay,
      ...options,
    });
  return { operation, fingerprint, queueMessage, inject };
}

afterEach(() => {
  testing.resetSessionControllerForTest();
  resetCommandQueueStateForTest();
  resetDiagnosticRunActivityForTest();
  vi.restoreAllMocks();
});

it.each([
  ["agent allowlist intersection", "agent:agent:main", undefined, undefined],
  ["global allowlist intersection", "global", undefined, undefined],
  [
    "provider",
    undefined,
    { provider: "openai", model: "gpt-test" },
    { provider: "anthropic", model: "gpt-test" },
  ],
  [
    "model",
    undefined,
    { provider: "openai", model: "gpt-primary" },
    { provider: "openai", model: "gpt-fallback" },
  ],
] as const)(
  "distinguishes %s in steering authority",
  async (_dimension, sessionKey, firstRoute, secondRoute) => {
    const first = createQueueTestRun({ prompt: "first" });
    const second = createQueueTestRun({ prompt: "second" });
    if (sessionKey) {
      for (const run of [first, second]) {
        run.run.sessionKey = sessionKey;
        run.run.config = { agents: { ownership: "explicit", entries: { agent: {}, other: {} } } };
      }
      first.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"]]);
      second.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"], ["message"]]);
    }

    expect(await fingerprintFor(first, firstRoute)).not.toBe(
      await fingerprintFor(second, secondRoute),
    );
  },
);

it("keeps same-requester steering independent of session personal-context reassignment", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("owner@example.test");
    const other = ensureProfileForEmail("participant@example.test");
    const participantId = other.id;
    const run = createQueueTestRun({ prompt: "Session owner's turn" });
    run.run.bootstrapUserProfileId = owner.id;
    run.run.senderId = "first-participant";
    run.run.permissionMode = "full";
    run.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "original-operator",
      scopes: ["operator.read", "operator.write"],
      source: {},
      assertCurrent: () => {},
    });
    const { operation, fingerprint, queueMessage, inject } = await admit(
      run,
      "personal-steering",
      run.run,
      () => true,
    );
    const incoming = {
      ...run,
      run: { ...run.run, senderId: participantId, bootstrapUserProfileId: participantId },
    };
    expect(await fingerprintFor(incoming)).toBe(fingerprint);
    for (const options of [
      {
        toolAuthorityFingerprint: await fingerprintFor(incoming),
      },
      { toolAuthorityOverlay: toolAuthorityOverlay(incoming) },
    ]) {
      await expect(inject(undefined, options)).resolves.toMatchObject({ status: "accepted" });
    }
    expect(queueMessage).toHaveBeenCalledTimes(2);
    for (const [, options] of queueMessage.mock.calls) {
      expect(options).not.toHaveProperty("bootstrapUserProfileId");
      expect(options).not.toHaveProperty("toolAuthorityOverlay");
    }
    expect(run.run.bootstrapUserProfileId).toBe(owner.id);
    expect(incoming.run.bootstrapUserProfileId).toBe(participantId);
    expect(operation.toolAuthorityFingerprint).toBe(fingerprint);

    for (const changed of [
      { permissionMode: "guarded" },
      { toolOverrides: { webSearch: false } },
      { operatorAuthority: undefined },
      {
        operatorAuthority: createAdmittedRunOperatorAuthority({
          ...run.operatorAuthority,
          scopes: ["operator.admin"],
        }),
      },
    ] satisfies Partial<ReplyToolAuthorityOverlay>[]) {
      await expect(
        inject({ ...toolAuthorityOverlay(incoming), ...changed }),
      ).resolves.toMatchObject(rejected);
    }
    expect(queueMessage).toHaveBeenCalledTimes(2);
  }));

it.each([
  ["automatic rotation", "auto", "auto", "backup", "full", true],
  ["unchanged user pin", "user", "user", "primary", "full", true],
  ["changed user pin", "user", "user", "backup", "full", false],
  ["explicit pin replacing automatic selection", "auto", "user", "primary", "full", false],
  ["removed automatic selection", "auto", undefined, undefined, "full", false],
  ["permission change during automatic rotation", "auto", "auto", "backup", "guarded", false],
] as const)(
  "preserves steering admission for %s",
  async (_name, source, nextSource, nextProfile, permissionMode, accepted) => {
    const run = createQueueTestRun({ prompt: "running request" });
    run.run.authProfileId = "openai:primary";
    run.run.authProfileIdSource = source;
    run.run.permissionMode = "full";
    const { queueMessage, inject } = await admit(run, "profile-steering");
    const incoming = {
      ...run,
      run: {
        ...run.run,
        authProfileId: nextProfile ? `openai:${nextProfile}` : undefined,
        authProfileIdSource: nextSource,
        permissionMode,
      },
    };

    await expect(
      inject(undefined, { toolAuthorityFingerprint: await fingerprintFor(incoming) }),
    ).resolves.toMatchObject(accepted ? { status: "accepted" } : rejected);
    expect(queueMessage).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(run.run.authProfileId).toBe("openai:primary");
  },
);

it.each(["complete", "abortForRestart"] as const)(
  "requires a snapshot for route preparation and rejects it after %s",
  async (close) => {
    const run = createQueueTestRun({ prompt: "operation projection" });
    const operation = createTestReplyOperation({ sessionId: "session-projector" });
    const snapshot = prepareReplyToolAuthority(run);
    const overlay = toolAuthorityOverlay(run);
    const route = { provider: "openai", model: "gpt-primary" };

    expect(() => operation.bindToolAuthorityRoute(route)).toThrow(
      "Reply operation has no active tool authority snapshot",
    );
    expect(operation.toolAuthorityRoute).toBeUndefined();
    expect(operation.toolAuthorityFingerprint).toBeUndefined();
    await operation.bindToolAuthoritySnapshotAsync(snapshot);
    expect(await operation.projectToolAuthorityFingerprintAsync(overlay)).toBeUndefined();

    const fingerprint = await fingerprintFor(run, route);
    expect(await operation.bindToolAuthorityRouteAsync(route)).toBe(fingerprint);
    expect(await operation.projectToolAuthorityFingerprintAsync(overlay)).toBe(fingerprint);

    operation[close]();
    expect(await operation.projectToolAuthorityFingerprintAsync(overlay)).toBeUndefined();
    expect(() => operation.bindToolAuthorityRoute({ ...route, model: "gpt-late" })).toThrow(
      "Reply operation has no active tool authority snapshot",
    );
    expect(operation.toolAuthorityRoute).toEqual(route);
    expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
  },
);

it("keeps the initial policy snapshot while tracking concrete fallback authority", async () => {
  const run = createQueueTestRun({ prompt: "route authority" });
  const operation = createTestReplyOperation({ sessionId: "session-route" });
  const snapshot = prepareReplyToolAuthority(run);
  const primary = { provider: "openai", model: "gpt-primary" };
  const fallback = { provider: "anthropic", model: "claude-fallback" };
  const primaryFingerprint = await fingerprintFor(run, primary);
  const fallbackFingerprint = await fingerprintFor(run, fallback);
  const overlay = toolAuthorityOverlay(run);
  await operation.bindToolAuthoritySnapshotAsync(snapshot);

  expect(await operation.bindToolAuthorityRouteAsync(primary)).toBe(primaryFingerprint);
  expect(operation.toolAuthorityRoute).toEqual(primary);
  expect(operation.toolAuthorityFingerprint).toBe(primaryFingerprint);

  run.run.execOverrides = { security: "deny" };
  expect(() => operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run))).toThrow(
    "Reply operation cannot change tool authority after admission",
  );
  expect(operation.toolAuthorityFingerprint).toBe(primaryFingerprint);
  expect(await operation.bindToolAuthorityRouteAsync(fallback)).toBe(fallbackFingerprint);
  expect(operation.toolAuthorityRoute).toEqual(fallback);
  expect(operation.toolAuthorityFingerprint).toBe(fallbackFingerprint);
  expect(await operation.projectToolAuthorityFingerprintAsync(overlay)).toBe(fallbackFingerprint);

  await operation.bindToolAuthoritySnapshotAsync(snapshot);
  expect(operation.toolAuthorityRoute).toEqual(fallback);
  expect(operation.toolAuthorityFingerprint).toBe(fallbackFingerprint);
  operation.attachBackend({
    kind: "embedded",
    cancel: vi.fn(),
    toolAuthorityFingerprint: "backend-exact-authority",
  });
  await operation.bindToolAuthoritySnapshotAsync(snapshot);
  expect(operation.toolAuthorityRoute).toEqual(fallback);
  expect(operation.toolAuthorityFingerprint).toBe("backend-exact-authority");
  operation.complete();
});

it.each([
  ...[false, true].map((withModelPolicy) => ({
    withModelPolicy,
    grantKind: "bound",
    grant: { pluginId: "access-policy", grantId: "original-grant" },
    toolsAllow: withModelPolicy ? undefined : ["screen"],
  })),
  { withModelPolicy: true, grantKind: "independent", grant: null, toolsAllow: ["theme"] },
  { withModelPolicy: true, grantKind: "unclassified", grant: undefined, toolsAllow: undefined },
])(
  "preserves same-requester reconnects and rejects other profiles (model policy: $withModelPolicy, grant: $grantKind)",
  async ({ withModelPolicy, grant, toolsAllow }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profileId = ensureProfileForEmail("steering-operator@example.test").id;
      const otherProfileId = ensureProfileForEmail("another-steering-operator@example.test").id;
      setUserProfileRole(profileId, withModelPolicy ? "writer" : null);
      setUserProfileRole(otherProfileId, withModelPolicy ? "writer" : null);
      const scopes: GatewayOperatorRoleDefinition["scopes"] = [
        "operator.admin",
        "operator.read",
        "operator.write",
      ];
      const defaultModel = { primary: "openai/gpt-test", fallbacks: ["openai/gpt-fallback"] };
      const writer: GatewayOperatorRoleDefinition = {
        scopes,
        agents: "*",
        sessions: { others: "none" },
        modelPolicy: {},
      };
      let config: OpenClawConfig = withModelPolicy
        ? {
            agents: { defaults: { model: defaultModel } },
            gateway: { roles: { definitions: { writer } } },
          }
        : {};
      const context = { getRuntimeConfig: () => config };
      const clientFor = (id = profileId) =>
        createOperatorClient({ profileId: id, scopes, caps: ["ui-commands"] });
      const originalClient = clientFor();
      const reconnectedClient = clientFor();
      reconnectedClient.connId = "reconnected-browser";
      const originalRevocation = new AbortController();
      const reconnectedRevocation = new AbortController();
      const cleanups: Array<() => void> = [];
      const capture = async (
        client: typeof originalClient,
        signal: AbortSignal,
        gatewayAccessGrant: GatewayAccessGrantRef | null | undefined,
        grantSignal = new AbortController().signal,
      ) => {
        const caller = captureGatewayDeviceRevocation(
          context,
          { deviceId: "same-device", role: "operator" },
          () => !signal.aborted,
          undefined,
          {
            dependencies: { client, context, authPolicyGeneration: "same-policy" },
            isCurrent: () => !signal.aborted,
            subscribe: () => () => {},
          },
        );
        cleanups.push(caller.release);
        const owner = await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority: caller.isCurrent,
          sourceAuthority:
            gatewayAccessGrant === null
              ? null
              : {
                  gatewayAccessGrant,
                  signal: grantSignal,
                  assertCurrent: () => grantSignal.throwIfAborted(),
                },
        });
        if (!owner) {
          throw new Error("Expected an authenticated operator authority");
        }
        cleanups.push(owner.release);
        return owner.authority;
      };
      try {
        const run = createQueueTestRun({ prompt: "keep playing" });
        run.toolsAllow = toolsAllow;
        run.operatorAuthority = await capture(originalClient, originalRevocation.signal, grant);
        run.run.gatewayUiCommandTarget = { connId: originalClient.connId!, profileId };
        run.run.approvalReviewerDeviceId = "original-reviewer";
        run.run.clientCaps = ["ui-commands"];
        run.run.toolBindings = { browser: { kind: "tab", targetId: "original-tab" } };
        run.run.senderIsOwner = true;
        run.run.permissionMode = "full";
        const reconnectedAuthority = await capture(
          reconnectedClient,
          reconnectedRevocation.signal,
          grant,
        );
        const {
          fingerprint,
          queueMessage,
          inject: injectInput,
        } = await admit(run, "reconnected-steering");
        const overlay = {
          ...toolAuthorityOverlay(run),
          operatorAuthority: reconnectedAuthority,
          gatewayUiCommandTarget: { connId: reconnectedClient.connId!, profileId },
          approvalReviewerDeviceId: "new-reviewer",
        };
        const inject = (changes: Partial<ReplyToolAuthorityOverlay> = {}) =>
          injectInput({ ...overlay, ...changes });
        await expect(
          inject({
            operatorAuthority:
              grant === undefined
                ? run.operatorAuthority
                : await capture(originalClient, originalRevocation.signal, grant),
            gatewayUiCommandTarget: run.run.gatewayUiCommandTarget,
          }),
        ).resolves.toEqual({ status: "accepted" });
        config = { ...config };
        await expect(inject()).resolves.toEqual(
          grant === undefined ? rejected : { status: "accepted" },
        );
        const otherAuthority = await capture(
          clientFor(otherProfileId),
          new AbortController().signal,
          grant,
        );
        await expect(
          inject({
            operatorAuthority: otherAuthority,
            gatewayUiCommandTarget: { connId: "other-browser", profileId: otherProfileId },
          }),
        ).resolves.toEqual(rejected);
        const acceptedMessages = grant === undefined ? 1 : 2;
        expect(queueMessage).toHaveBeenCalledTimes(acceptedMessages);
        expect(queueMessage).toHaveBeenLastCalledWith(
          "change strategy",
          expect.objectContaining({
            toolAuthorityFingerprint: fingerprint,
          }),
        );
        const forwarded = queueMessage.mock.calls.at(-1)?.[1];
        expect(forwarded).not.toHaveProperty("operatorAuthority");
        expect(forwarded).not.toHaveProperty("gatewayUiCommandTarget");
        expect(forwarded).not.toHaveProperty("approvalReviewerDeviceId");
        expect(forwarded).not.toHaveProperty("toolBindings");
        for (const changedGrant of [
          { pluginId: "access-policy", grantId: "replacement-grant" },
          { pluginId: "other-policy", grantId: "original-grant" },
          ...(grant === null ? [] : [null]),
          ...(grant === undefined ? [] : [undefined]),
        ]) {
          await expect(
            inject({
              operatorAuthority: await capture(
                reconnectedClient,
                reconnectedRevocation.signal,
                changedGrant,
              ),
            }),
          ).resolves.toMatchObject(rejected);
          expect(queueMessage).toHaveBeenCalledTimes(acceptedMessages);
        }
        if (grant !== null) {
          const revokedGrant = new AbortController();
          const revokedAuthority = await capture(
            reconnectedClient,
            reconnectedRevocation.signal,
            grant,
            revokedGrant.signal,
          );
          revokedGrant.abort();
          await expect(inject({ operatorAuthority: revokedAuthority })).resolves.toMatchObject(
            rejected,
          );
          expect(queueMessage).toHaveBeenCalledTimes(acceptedMessages);
        }
        for (const changed of [
          {
            operatorAuthority: createAdmittedRunOperatorAuthority({
              ...reconnectedAuthority,
              scopes: ["operator.read"],
            }),
          },
          {
            operatorAuthority: otherAuthority,
            gatewayUiCommandTarget: { connId: "other-browser", profileId },
          },
          { gatewayUiCommandTarget: { connId: "other-browser", profileId: otherProfileId } },
          { gatewayUiCommandTarget: undefined },
          ...["openai/gpt-test", "openai/another-model"].map((model) => ({
            operatorAuthority: createAdmittedRunOperatorAuthority({
              ...reconnectedAuthority,
              modelPolicy: prepareOperatorModelPolicy({
                cfg: config,
                policy: { allow: [model] },
              }),
            }),
          })),
          { clientCaps: [] },
          { toolBindings: { browser: { kind: "tab", targetId: "different-tab" } } },
        ]) {
          await expect(inject(changed)).resolves.toMatchObject(rejected);
        }
        reconnectedRevocation.abort();
        await expect(inject()).resolves.toMatchObject(rejected);
        const liveReplacement = await capture(
          reconnectedClient,
          new AbortController().signal,
          grant,
        );
        originalRevocation.abort();
        await expect(inject({ operatorAuthority: liveReplacement })).resolves.toMatchObject(
          rejected,
        );
        expect(queueMessage).toHaveBeenCalledTimes(acceptedMessages);
      } finally {
        for (const release of cleanups.toReversed()) {
          release();
        }
      }
    }),
);

it("projects inbound authority without forwarding a changed approval destination", async () => {
  const run = createQueueTestRun({ prompt: "projected inbound" });
  run.run.approvalReviewerDeviceId = "device-a";
  run.run.gatewayUiCommandTarget = { connId: "browser-a", profileId: "profile-a" };
  run.run.clientCaps = ["ui-commands"];
  run.run.senderIsOwner = true;
  run.run.permissionMode = "full";
  const route = { provider: "openai", model: "gpt-primary" };
  const overlay = { ...toolAuthorityOverlay(run), approvalReviewerDeviceId: "device-b" };
  const { queueMessage, inject } = await admit(
    run,
    "session-projected-authority",
    route,
    () => true,
  );

  await expect(
    inject(overlay, {
      toolAuthorityFingerprint: "caller-cannot-override-projection",
    }),
  ).resolves.toEqual({ status: "accepted" });
  const forwardedOptions = queueMessage.mock.calls[0]?.[1];
  expect(forwardedOptions).toMatchObject({
    isInboundUserMessage: true,
    toolAuthorityFingerprint: await fingerprintFor(run, route),
  });
  expect(forwardedOptions).not.toHaveProperty("toolAuthorityOverlay");
  expect(forwardedOptions).not.toHaveProperty("approvalReviewerDeviceId");
  expect(queueMessage).toHaveBeenCalledOnce();

  for (const restricted of [
    { clientCaps: ["changed-capability"] },
    { gatewayUiCommandTarget: { connId: "browser-b", profileId: "profile-a" } },
    { gatewayUiCommandTarget: { connId: "browser-a", profileId: "profile-b" } },
    { gatewayUiCommandTarget: undefined },
    { toolBindings: { browser: { clientId: "different-browser" } } },
    { permissionMode: "guarded" },
    { forceRestartSafeTools: true },
    { forceCodeModeTools: true },
  ] satisfies Partial<ReplyToolAuthorityOverlay>[]) {
    await expect(inject({ ...overlay, ...restricted })).resolves.toMatchObject(rejected);
    expect(queueMessage).toHaveBeenCalledOnce();
  }
});

it.each([
  { restriction: "disabled", themeAvailable: false },
  { restriction: "no-capability", themeAvailable: true },
  { restriction: "runtime-intersection", themeAvailable: false },
  { restriction: "policy-deny", themeAvailable: true },
  { restriction: "policy-theme-deny", themeAvailable: false },
  { restriction: "non-owner", themeAvailable: true },
])(
  "preserves steering within available theme authority when screen is unavailable: $restriction",
  async ({ restriction, themeAvailable }) => {
    const run = createQueueTestRun({ prompt: "cross-browser steering" });
    run.run.gatewayUiCommandTarget = { connId: "browser-a", profileId: "profile-a" };
    run.run.clientCaps = ["ui-commands"];
    run.run.senderIsOwner = restriction !== "non-owner";
    if (restriction === "disabled") {
      run.disableTools = true;
    }
    if (restriction === "no-capability") {
      run.run.clientCaps = [];
    }
    if (restriction === "runtime-intersection") {
      run.toolsAllow = attachToolAllowlistIntersection(
        ["read", "screen"],
        [["read", "screen"], ["read"]],
      );
    }
    if (restriction === "policy-deny") {
      run.run.config = { tools: { deny: ["screen"] } };
    }
    if (restriction === "policy-theme-deny") {
      run.run.config = { tools: { deny: ["screen", "theme"] } };
    }
    const { queueMessage, inject } = await admit(run, "screen-unavailable", run.run, () => true);

    await expect(
      inject({
        ...toolAuthorityOverlay(run),
        gatewayUiCommandTarget: { connId: "browser-b", profileId: "profile-a" },
      }),
    ).resolves.toEqual({ status: "accepted" });
    expect(queueMessage).toHaveBeenCalledOnce();

    for (const gatewayUiCommandTarget of [
      { connId: "browser-b", profileId: "profile-b" },
      { connId: "browser-b" },
      undefined,
    ]) {
      await expect(
        inject({ ...toolAuthorityOverlay(run), gatewayUiCommandTarget }),
      ).resolves.toEqual(themeAvailable ? rejected : { status: "accepted" });
    }
    expect(queueMessage).toHaveBeenCalledTimes(themeAvailable ? 1 : 4);
  },
);
