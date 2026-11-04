import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { ensureSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as support from "./service.test-support.js";

const guest = vi.hoisted(() => ({
  controller: new AbortController(),
  revoked: false,
  realAuthority: false,
  scopes: ["operator.sessions.write"],
}));
vi.mock("./session-guest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-guest.js")>();
  return {
    ...actual,
    prepareSessionGuestAuthority: async (
      ...args: Parameters<typeof actual.prepareSessionGuestAuthority>
    ) => {
      if (guest.realAuthority) {
        return actual.prepareSessionGuestAuthority(...args);
      }
      if (guest.revoked) {
        throw new actual.SessionGuestAccessRevokedError();
      }
      return {
        signal: guest.controller.signal,
        assertCurrent: () => {
          if (guest.revoked || guest.controller.signal.aborted) {
            throw new actual.SessionGuestAccessRevokedError();
          }
        },
        release: () => {},
      };
    },
  };
});

// A full importOriginal here re-enters the role-policy mock during module collection.
vi.mock("../../state/user-profile-list.js", () => ({
  prepareUserProfileIdentity: async (profileId: string) => ({
    readCurrentFacts: () => ({
      profile: { profileId, assignedRole: "guest", githubLogin: null },
      aliases: new Set<string>(),
    }),
    release: () => {},
  }),
}));
vi.mock("../operator-role-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operator-role-policy.js")>();
  return {
    ...actual,
    resolveOperatorRolePolicyForAssignment: (
      ...args: Parameters<typeof actual.resolveOperatorRolePolicyForAssignment>
    ) => {
      const role = actual.resolveOperatorRolePolicyForAssignment(...args);
      return guest.realAuthority && args[0] === "guest-a"
        ? { ...role, scopes: guest.scopes }
        : role;
    },
  };
});
vi.mock("../operator-access-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../operator-access-policy.js")>();
  return {
    ...actual,
    resumeGatewayOperatorAccessGrant: (
      ...args: Parameters<typeof actual.resumeGatewayOperatorAccessGrant>
    ) => {
      if (guest.realAuthority && args[0].profileId === "guest-a") {
        const assertCurrent = () => {
          if (guest.revoked) {
            throw new actual.GatewayOperatorAccessDeniedError();
          }
        };
        assertCurrent();
        return { signal: guest.controller.signal, assertCurrent };
      }
      return actual.resumeGatewayOperatorAccessGrant(...args);
    },
  };
});

import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";

support.setupWorkerEnvironmentServiceSuite((config, root) => {
  config.session = { store: path.join(root, "sessions.json") };
});
const identity = {
  agentId: "main",
  sessionKey: "agent:main:guest-relay",
  sessionId: "guest-session",
  principalId: "guest-a",
};
const binding = {
  profileId: "guest-a",
  sessionId: identity.sessionId,
  grant: { pluginId: "visitor-access", grantId: "grant-a" },
};
let service: ReturnType<typeof support.createService>;
let provider: ReturnType<typeof support.createProvider>;
const destroy = vi.fn(async () => {});
type Command = NonNullable<
  NonNullable<Parameters<typeof support.createService>[1]>["runSessionEnvironmentCommand"]
>;
const command = vi.fn<Command>(async (_binding, operation) => {
  operation.assertCurrent?.();
  return {
    stdout: "guest-ok",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
    workspaceDir: "/workspace",
  };
});
const start = () => {
  service = support.createService(provider, {
    ensureNodeWorkerBundle: async () => support.BOOTSTRAP_RECEIPT,
    prepareNodeRuntime: async () => {
      throw new Error("Guest provider must not request model runtime preparation");
    },
    prepareNodeEnrollment: async () => {
      throw new Error("Synthetic provider does not bootstrap a real node");
    },
    runSessionEnvironmentCommand: command,
  });
};
const create = () =>
  service.createSessionAttachment(
    {
      ...identity,
      guest: binding,
      profileId: "development",
      idempotencyKey: "guest-create",
      machineClass: "supported-shape",
      os: "linux",
    },
    () => {},
  );

beforeEach(() => {
  guest.controller = new AbortController();
  guest.revoked = false;
  guest.realAuthority = false;
  guest.scopes = ["operator.sessions.write"];
  destroy.mockReset();
  destroy.mockResolvedValue(undefined);
  command.mockClear();
  ensureSessionEntrySync(
    {
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      storePath: support.testState.config.session?.store,
    },
    { sessionId: identity.sessionId, updatedAt: 1 },
  );
  provider = support.createProvider({
    supportsUntrustedWorkloads: true,
    requiresNodeEnrollment: true,
    provisionBeforeInstallation: true,
    provision: vi.fn(async () => ({
      leaseId: "guest-lease",
      sharedHost: false,
      node: { deviceId: "guest-node" },
    })),
    destroy,
  });
  start();
});

it("creates a typed guest machine and runs commands without delivering inference credentials", async () => {
  const created = await create();
  expect(created.environment.state).toBe("ready");
  expect(provider.provision).toHaveBeenCalledWith(
    expect.any(Object),
    expect.any(String),
    expect.objectContaining({
      untrustedWorkload: true,
      machineClass: "supported-shape",
      os: "linux",
    }),
  );
  expect(
    JSON.stringify(support.testState.store.getCredential(created.environment.environmentId)),
  ).not.toContain(support.CREDENTIAL);
  const result = await service.execSessionAttachment(
    service.captureSessionAttachment(identity).binding,
    { transportRetry: "never", argv: ["printf", "guest-ok"], assertCurrent: () => {} },
  );
  expect(result.stdout).toBe("guest-ok");
  expect(
    service.getSessionAttachmentStatus(identity.sessionId, identity.principalId)?.attachment
      .environmentId,
  ).toBe(created.environment.environmentId);
  expect(() => service.captureSessionAttachment({ ...identity, principalId: "guest-b" })).toThrow();
  expect(() => service.getSessionAttachmentStatus(identity.sessionId, "guest-b")).toThrow();
  await expect(
    service.execSessionAttachment(
      { ...service.captureSessionAttachment(identity).binding, sessionId: "other" },
      { transportRetry: "never", argv: ["true"] },
    ),
  ).rejects.toThrow();
  await expect(
    service.attachSession({
      environmentId: created.environment.environmentId,
      ownerEpoch: created.environment.ownerEpoch,
      sessionId: "other-model-session",
    }),
  ).rejects.toThrow("Conversation-attached environments");
  await service.destroySessionAttachment(
    { sessionId: identity.sessionId, principalId: identity.principalId },
    () => {},
  );
  expect(destroy).toHaveBeenCalledOnce();
});

it("revokes access immediately and retries trusted teardown across service restart", async () => {
  const created = await create();
  const captured = service.captureSessionAttachment(identity);
  destroy.mockRejectedValueOnce(new Error("temporary provider cleanup failure"));
  guest.revoked = true;
  guest.controller.abort();
  expect(() => captured.assertCurrent()).toThrow();
  await support.waitForFast(() => expect(destroy).toHaveBeenCalledOnce());
  await service.stop();
  await support.reopenWorkerEnvironmentStore();
  support.testState.nowMs += 60_000;
  start();
  await service.reconcileSessionAttachments();
  await support.waitForFast(() =>
    expect(support.testState.store.get(created.environment.environmentId)?.state).toBe("destroyed"),
  );
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(() => service.captureSessionAttachment(identity)).toThrow();
});

it("cancels inflight authority before a queued machine effect can run", async () => {
  await create();
  const captured = service.captureSessionAttachment(identity);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effect = vi.fn();
  command.mockImplementationOnce(async (_binding, operation) => {
    entered.resolve();
    await release.promise;
    expect(operation.signal?.aborted).toBe(true);
    operation.assertCurrent?.();
    effect();
    return {
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
      workspaceDir: "/workspace",
    };
  });
  const pending = service.execSessionAttachment(captured.binding, {
    transportRetry: "never",
    argv: ["install-tool"],
  });
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  guest.revoked = true;
  guest.controller.abort();
  release.resolve();
  await rejected;
  expect(effect).not.toHaveBeenCalled();
});

it("irreversibly cancels and retires a demoted guest even when its role is restored", async () => {
  guest.realAuthority = true;
  await create();
  const captured = service.captureSessionAttachment(identity);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effect = vi.fn();
  let operationSignal: AbortSignal | undefined;
  command.mockImplementationOnce(async (_binding, operation) => {
    operationSignal = operation.signal;
    entered.resolve();
    await release.promise;
    operation.assertCurrent?.();
    effect();
    return {
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
      workspaceDir: "/workspace",
    };
  });
  const pending = service.execSessionAttachment(captured.binding, {
    transportRetry: "never",
    argv: ["install-tool"],
  });
  const rejected = expect(pending).rejects.toThrow();
  try {
    await entered.promise;
    guest.scopes = ["operator.read"];
    invalidateOperatorRolePolicy(identity.principalId);
    expect(guest.controller.signal.aborted).toBe(false);
    expect(operationSignal?.aborted).toBe(true);
    guest.scopes = ["operator.sessions.write"];
    invalidateOperatorRolePolicy(identity.principalId);
    expect(() => captured.assertCurrent()).toThrow();
  } finally {
    release.resolve();
    await rejected;
  }
  expect(effect).not.toHaveBeenCalled();
  await support.waitForFast(() => expect(destroy).toHaveBeenCalledOnce());
});

it("persists requested resources in provider custody and refuses configuration substitution", async () => {
  provider.selectMachineResources = (settings, resources) => ({
    ...settings,
    requestedResources: resources,
  });
  const resources = { machineType: "native-shape", region: "test-region", diskSizeGb: 80 };
  const request = {
    ...identity,
    guest: binding,
    profileId: "development",
    idempotencyKey: "resource-create",
    os: "linux",
    resources,
  };
  const created = await service.createSessionAttachment(request, () => {});
  const record = support.testState.store.get(created.environment.environmentId);
  expect(record?.profileSnapshot.resources).toEqual(resources);
  expect(record?.profileSnapshot.settings).toMatchObject({ requestedResources: resources });
  expect(provider.provision).toHaveBeenCalledWith(
    expect.objectContaining({ requestedResources: resources }),
    expect.any(String),
    expect.any(Object),
  );
  await expect(
    service.createSessionAttachment(
      {
        ...request,
        idempotencyKey: "substitute",
        resources: { ...resources, region: "other-region" },
      },
      () => {},
    ),
  ).rejects.toThrow("different environment");
  expect(provider.provision).toHaveBeenCalledOnce();
});

it("does not grant a guest access to an existing credential-bearing worker attachment", async () => {
  const regular = await service.createSessionAttachment(
    { ...identity, profileId: "development", idempotencyKey: "regular-worker" },
    () => {},
  );
  const restricted = { ...identity, requiresIsolatedEnvironment: true as const };
  expect(() => service.captureSessionAttachment(restricted)).toThrow();
  expect(() => service.findSessionAttachment(restricted)).toThrow("isolated guest environment");
  expect(() =>
    service.getSessionAttachmentStatus(identity.sessionId, identity.principalId, true),
  ).toThrow("isolated guest environment");
  await expect(
    service.destroySessionAttachment(
      {
        sessionId: identity.sessionId,
        principalId: identity.principalId,
        requiresIsolatedEnvironment: true,
      },
      () => {},
    ),
  ).rejects.toThrow("isolated guest environment");
  expect(destroy).not.toHaveBeenCalled();
  expect(support.testState.store.get(regular.environment.environmentId)?.state).toBe("ready");
});

it.each(["inspection denied", "boundary changed", "policy digest changed"])(
  "requalifies the retained guest command before any node effect: %s",
  async (reason) => {
    await create();
    const captured = service.captureSessionAttachment(identity);
    command.mockClear();
    const inspection = vi.spyOn(provider, "inspect").mockRejectedValue(new Error(reason));
    await expect(
      service.execSessionAttachment(captured.binding, {
        transportRetry: "never",
        argv: ["printf", "must-not-run"],
        assertCurrent: () => {},
      }),
    ).rejects.toThrow();
    expect(inspection).toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  },
);
it("rechecks guest authority after current network qualification settles", async () => {
  await create();
  const captured = service.captureSessionAttachment(identity);
  command.mockClear();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  vi.spyOn(provider, "inspect").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { status: "active", sharedHost: false };
  });
  const pending = service.execSessionAttachment(captured.binding, {
    transportRetry: "never",
    argv: ["printf", "must-not-run"],
    assertCurrent: () => {},
  });
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  guest.revoked = true;
  guest.controller.abort();
  release.resolve();
  await rejected;
  expect(command).not.toHaveBeenCalled();
});

it("rejects a retained command when its lease changes during network qualification", async () => {
  await create();
  const captured = service.captureSessionAttachment(identity);
  command.mockClear();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  vi.spyOn(provider, "inspect").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { status: "active", sharedHost: false };
  });
  const originalGet = support.testState.store.get.bind(support.testState.store);
  let changed = false;
  const read = vi.spyOn(support.testState.store, "get").mockImplementation((id) => {
    const record = originalGet(id);
    return changed &&
      record &&
      (record.state === "ready" || record.state === "idle") &&
      id === captured.binding.environmentId
      ? { ...record, leaseId: "replacement-lease" }
      : record;
  });
  try {
    const pending = service.execSessionAttachment(captured.binding, {
      transportRetry: "never",
      argv: ["printf", "must-not-run"],
      assertCurrent: () => {},
    });
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    changed = true;
    release.resolve();
    await rejected;
    expect(command).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
