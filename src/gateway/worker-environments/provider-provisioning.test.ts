import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  WorkerProviderError,
  type WorkerExecutionMode,
  type WorkerLease,
  type WorkerMachineOption,
  type WorkerProfile,
  type WorkerProvider,
} from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { hashWorkerCredential } from "./credential.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import {
  readWorkerPlacementIdentity,
  projectWorkerSessionPlacement,
} from "./placement-projector.js";
import * as support from "./service.test-support.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("passes the configured profile id to preparation before persisting allocation possibility", async () => {
    const provision = vi.fn();
    const allocate = vi.fn(async () => {
      expect(support.testState.store.list()[0]).toMatchObject({ state: "provisioning" });
      return { leaseId: "lease-prepared", ssh: support.SSH_ENDPOINT };
    });
    const prepareProvision = vi.fn<NonNullable<WorkerProvider["prepareProvision"]>>(
      async (profile, operationId, options) => {
        expect(support.testState.store.list()[0]).toMatchObject({
          state: "requested",
          provisionOperationId: operationId,
        });
        expect(profile).toEqual({ region: "test" });
        expect(options).toEqual({ profileId: "development", machineClass: "large", os: "os-a" });
        return allocate;
      },
    );
    const service = support.createService(support.createProvider({ provision, prepareProvision }));
    await expect(
      service.create(
        "development",
        "prepared-request",
        "large",
        undefined,
        undefined,
        undefined,
        "os-a",
      ),
    ).resolves.toMatchObject({ state: "ready", leaseId: "lease-prepared" });
    expect(prepareProvision).toHaveBeenCalledOnce();
    expect(allocate).toHaveBeenCalledOnce();
    expect(provision).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout"])(
    "never allocates from preparation closed by %s",
    async (closure) => {
      const entered = createDeferredCore();
      const settled = createDeferredCore();
      const allocate = vi.fn(async () => ({ leaseId: "lease-late", ssh: support.SSH_ENDPOINT }));
      const destroy = vi.fn();
      const controller = new AbortController();
      const service = support.createService(
        support.createProvider({
          prepareProvision: async () => {
            entered.resolve();
            await settled.promise;
            return allocate;
          },
          destroy,
        }),
        closure === "timeout" ? { providerCallTimeoutMs: 25 } : {},
      );
      const creation = service
        .create(
          "development",
          "closed-preparation",
          undefined,
          undefined,
          undefined,
          controller.signal,
        )
        .catch((error: unknown) => error);
      await entered.promise;
      if (closure === "abort") {
        controller.abort(new Error("Stop before allocation"));
        settled.resolve();
      }
      await creation;
      settled.resolve();
      const environment = support.testState.store.list()[0]!;
      await service.destroy(environment.environmentId);
      await service.stop();
      expect(support.testState.store.get(environment.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
      });
      expect(allocate).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it("does not invoke a late prepared allocation after replay times out", async () => {
    const entered = createDeferredCore();
    const settled = createDeferredCore();
    const lateAllocation = vi.fn(async () => ({ leaseId: "lease-1", ssh: support.SSH_ENDPOINT }));
    let preparations = 0;
    const service = support.createService(
      support.createProvider({
        prepareProvision: async () => {
          if (++preparations === 1) {
            return async () => {
              throw new Error("synthetic response lost after allocation");
            };
          }
          entered.resolve();
          await settled.promise;
          return lateAllocation;
        },
      }),
      { providerCallTimeoutMs: 25 },
    );
    await expect(service.create("development", "replayed-preparation")).rejects.toThrow(
      "response lost after allocation",
    );
    const replay = service
      .create("development", "replayed-preparation")
      .catch((error: unknown) => error);
    await entered.promise;
    await replay;
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });
    settled.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(lateAllocation).not.toHaveBeenCalled();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });
  });

  it("persists intent and passes the configured profile id and immutable settings to provisioning", async () => {
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (profile, operationId, options) => {
        operationIds.push(operationId);
        expect(support.testState.store.list()[0]).toMatchObject({
          state: "provisioning",
          provisionOperationId: operationId,
          profileSnapshot: {
            install: "bundle",
            machineClass: "beast",
            os: "os-a",
            settings: { region: "test" },
          },
        });
        support.getDevelopmentProfile().settings = { region: "mutated" };
        expect(profile).toEqual({ region: "test" });
        expect(options).toEqual({ profileId: "development", machineClass: "beast", os: "os-a" });
        return { leaseId: "lease-1", ssh: support.SSH_ENDPOINT };
      },
    });

    const workerService = support.createService(provider);
    const create = (machineClass = "beast", os: string | undefined = "os-a") =>
      workerService.create(
        "development",
        "request-1",
        machineClass,
        undefined,
        undefined,
        undefined,
        os,
      );
    const result = await create();
    const repeated = await create();

    expect(result).toMatchObject({ state: "ready", leaseId: "lease-1", ownerEpoch: 1 });
    expect(repeated.environmentId).toBe(result.environmentId);
    expect(operationIds).toHaveLength(1);
    expect(operationIds[0]).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(result.profileSnapshot).toMatchObject({ settings: { region: "test" } });
    expect(support.testState.store.getCredential(result.environmentId)).toMatchObject({
      credentialHash: hashWorkerCredential(support.CREDENTIAL),
      ownerEpoch: 1,
      sessionId: null,
    });
    const persistedCredential = support.testState.stateDb.db
      .prepare("SELECT * FROM worker_environment_credentials WHERE environment_id = ?")
      .get(result.environmentId);
    expect(persistedCredential).toMatchObject({
      credential_hash: hashWorkerCredential(support.CREDENTIAL),
    });
    expect(JSON.stringify(persistedCredential)).not.toContain(support.CREDENTIAL);
    const binding = { environmentId: result.environmentId, ownerEpoch: 1, sessionId: null };
    const grant = workerService.takeMintedCredential(binding);
    expect(grant).toMatchObject({
      credential: support.CREDENTIAL,
      ownerEpoch: 1,
      sessionId: null,
    });
    expect(workerService.acknowledgeCredentialDelivery(grant!)).toBe(true);
    expect(support.testState.store.getCredential(result.environmentId)).toMatchObject({
      deliveredAtMs: support.testState.nowMs,
    });
    expect(workerService.takeMintedCredential(binding)).toBeUndefined();
    for (const [machineClass, os] of [
      ["fast", "os-a"],
      ["beast", "os-b"],
      ["beast", undefined],
    ]) {
      await expect(
        workerService.create(
          "development",
          "request-1",
          machineClass,
          undefined,
          undefined,
          undefined,
          os,
        ),
      ).rejects.toMatchObject({ code: "invalid_profile" });
    }
    expect(operationIds).toHaveLength(1);
  });

  it("requires explicit placement modes before provider allocation", async () => {
    const provision = vi.fn(support.createProvider().provision);
    const provider = support.createProvider({ supportedExecutionModes: undefined, provision });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "mode-configured", undefined, "remote-exec"),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(
      workerService.createFromProfileSnapshot(
        {
          profileId: "development",
          providerId: provider.id,
          profileSnapshot: { install: "bundle", settings: { region: "test" } },
        },
        "mode-inherited",
        undefined,
        "worker-turn",
      ),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);

    await expect(workerService.create("development", "lifecycle-only")).resolves.toMatchObject({
      state: "ready",
    });
    expect(provision).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledWith(
      { region: "test" },
      expect.stringMatching(/^provision:v2:[a-f0-9]{64}$/u),
      { profileId: "development" },
    );
  });

  it("P1: direct creation preserves the default setup of an advertised node provider", async () => {
    const provision = vi.fn(async () => ({
      leaseId: "lease-direct-default-node",
      node: { deviceId: "device-direct-default-node" },
    }));
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn", "remote-exec"],
        provision,
      }),
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );

    const environment = await workerService.create("development", "request-direct-default-node");

    expect(environment).toMatchObject({
      state: "ready",
      nodeDeviceId: "device-direct-default-node",
    });
    expect(environment.profileSnapshot).not.toHaveProperty("executionMode");
    expect(provision).toHaveBeenCalledWith(
      { region: "test" },
      expect.stringMatching(/^provision:v2:[a-f0-9]{64}$/u),
      { profileId: "development" },
    );
  });

  it.each<{
    mode: WorkerExecutionMode;
    lease: WorkerLease;
    transport: "node" | "SSH";
    inherited?: true;
  }>([
    {
      mode: "worker-turn",
      lease: { leaseId: "lease-worker-turn-node", node: { deviceId: "worker-turn-device" } },
      transport: "node",
    },
    {
      mode: "remote-exec",
      lease: { leaseId: "lease-remote-exec-node", node: { deviceId: "remote-exec-device" } },
      transport: "node",
    },
    {
      mode: "remote-exec",
      lease: { leaseId: "lease-remote-exec-ssh", ssh: support.SSH_ENDPOINT },
      transport: "SSH",
    },
    {
      mode: "remote-exec",
      lease: { leaseId: "lease-inherited-node", node: { deviceId: "inherited-device" } },
      transport: "node",
      inherited: true,
    },
  ])(
    "forwards $mode placement to its $transport provider transport (inherited: $inherited)",
    async ({ mode, lease, transport, inherited }) => {
      const provision = vi.fn(async () => lease);
      const provider = support.createProvider({
        supportedExecutionModes: ["worker-turn", "remote-exec"],
        provision,
      });
      const workerService = support.createService(provider, {
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      });
      const idempotencyKey = `transport-${mode}-${transport}-${inherited ? "inherited" : "profile"}`;

      const result = inherited
        ? await workerService.createFromProfileSnapshot(
            {
              profileId: "development",
              providerId: provider.id,
              profileSnapshot: { install: "bundle", settings: { region: "test" } },
            },
            idempotencyKey,
            undefined,
            mode,
          )
        : await workerService.create("development", idempotencyKey, undefined, mode);

      expect(result).toMatchObject({
        state: "ready",
        leaseId: lease.leaseId,
        profileSnapshot: { executionMode: mode, settings: { region: "test" } },
        ...(lease.node ? { nodeDeviceId: lease.node.deviceId, sshEndpoint: null } : {}),
      });
      expect(provision).toHaveBeenCalledWith(
        { region: "test" },
        expect.stringMatching(/^provision:v2:[a-f0-9]{64}$/u),
        { profileId: "development", executionMode: mode },
      );
      expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(transport === "SSH" ? 1 : 0);
    },
  );

  it("rejects an SSH lease for worker-turn placement even when its provider also supports remote-exec", async () => {
    const lease = { leaseId: "lease-worker-turn-ssh", ssh: support.SSH_ENDPOINT };
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn", "remote-exec"],
      provision: async () => lease,
      destroy,
    });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "transport-worker-turn-ssh", undefined, "worker-turn"),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("worker-turn providers must return a node lease"),
    });

    expect(destroy).toHaveBeenCalledWith({ leaseId: lease.leaseId, profile: { region: "test" } });
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([
      expect.objectContaining({
        state: "failed",
        leaseId: null,
        nodeDeviceId: null,
        sshEndpoint: null,
        lastError: "worker-turn providers must return a node lease",
      }),
    ]);
  });

  it("rejects a repeated operation id when its selected execution mode changes", async () => {
    const provision = vi.fn(async () => ({
      leaseId: "lease-stable-operation-mode",
      node: { deviceId: "device-stable-operation-mode" },
    }));
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn", "remote-exec"],
        provision,
      }),
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );

    const original = await workerService.create(
      "development",
      "request-stable-operation-mode",
      undefined,
      "worker-turn",
    );
    await expect(
      workerService.create(
        "development",
        "request-stable-operation-mode",
        undefined,
        "worker-turn",
      ),
    ).resolves.toMatchObject({ environmentId: original.environmentId });
    await expect(
      workerService.create(
        "development",
        "request-stable-operation-mode",
        undefined,
        "remote-exec",
      ),
    ).rejects.toMatchObject({ code: "invalid_profile" });

    expect(provision).toHaveBeenCalledOnce();
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "ready",
      leaseId: original.leaseId,
    });
  });

  it("preserves per-OS machine identities and defaults from the profile provider", async () => {
    const machines = [
      { id: "standard", label: "Standard", cpu: 32, memoryGb: 64, default: true, os: "os-a" },
      { id: "standard", label: "Standard", default: true, os: "os-b" },
      { id: "shared", label: "Shared" },
    ];
    const systems = [
      { id: "os-a", label: "OS A", default: true },
      { id: "os-b", label: "OS B", disabledReason: "Upgrade the worker provider." },
    ];
    const listMachineOptions = vi.fn(async () => machines).mockResolvedValueOnce([machines[0]!]);
    const listOperatingSystems = vi.fn(async () => systems);
    const workerService = support.createService(
      support.createProvider({ listMachineOptions, listOperatingSystems }),
    );

    const cases: Array<{ id: string; overrides: WorkerProfile }> = [
      { id: "default", overrides: {} },
      { id: "override", overrides: { machineClass: "standard", os: "os-b" } },
      { id: "unknown", overrides: { machineClass: "custom", os: "other" } },
    ];
    const records = cases.map(({ id, overrides }) =>
      support.testState.store.createIntent({
        environmentId: id,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" }, ...overrides },
        provisionOperationId: `provision:${id}`,
      }),
    );
    const project = (record: (typeof records)[number]) => {
      const placement = {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        agentId: "main",
        executionMode: "worker-turn" as const,
        state: "provisioning" as const,
        environmentId: record.environmentId,
        activeOwnerEpoch: null,
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        workspaceBaseManifestRef: null,
        remoteWorkspaceDir: null,
        workerBundleHash: null,
        lastTranscriptAckCursor: null,
        lastLiveEventAckCursor: null,
        recoveryError: null,
        terminalReason: null,
        terminalAtMs: null,
        turnClaim: null,
      };
      return projectWorkerSessionPlacement(
        placement,
        undefined,
        undefined,
        readWorkerPlacementIdentity(placement, workerService),
      );
    };
    expect(project(records[0]!)).not.toHaveProperty("machine");
    expect(project(records[1]!)).toMatchObject({ machine: { class: "standard", os: "os-b" } });
    const coldVersion = workerService.machineShapeVersion();
    await workerService.listMachineOptions("development");
    expect(project(records[0]!)).toMatchObject({
      machine: { class: "standard", cpu: 32, memoryGb: 64 },
    });
    expect(project(records[0]!)).not.toHaveProperty("machine.os");
    await expect(workerService.listMachineOptions("development")).resolves.toEqual(machines);
    expect(project(records[0]!)).not.toHaveProperty("machine");
    await expect(workerService.listOperatingSystems("development")).resolves.toEqual(systems);
    expect(listMachineOptions).toHaveBeenCalledWith({ region: "test" });
    expect(listOperatingSystems).toHaveBeenCalledWith({ region: "test" });
    expect(project(records[0]!)).toMatchObject({
      machine: {
        class: "standard",
        os: "os-a",
        osLabel: "OS A",
        cpu: 32,
        memoryGb: 64,
      },
    });
    expect(project(records[1]!)).toMatchObject({
      machine: { class: "standard", os: "os-b", osLabel: "OS B" },
    });
    expect(project(records[1]!)).not.toHaveProperty("machine.cpu");
    expect(project(records[2]!)).toMatchObject({ machine: { class: "custom", os: "other" } });
    expect(workerService.machineShapeVersion()).toBeGreaterThan(coldVersion);
    const warmVersion = workerService.machineShapeVersion();
    await workerService.listMachineOptions("development");
    await workerService.listOperatingSystems("development");
    expect(workerService.machineShapeVersion()).toBe(warmVersion);

    support.getDevelopmentProfile().settings = { region: "changed" };
    await workerService.listMachineOptions("development");
    expect(project(records[0]!)).not.toHaveProperty("machine");
    expect(project(records[1]!)).toMatchObject({ machine: { class: "standard", os: "os-b" } });
  });

  it("warms the current profile while an earlier configuration catalog is still pending", async () => {
    const previousCatalog = createDeferredCore<readonly WorkerMachineOption[]>();
    const service = support.createService(
      support.createProvider({
        listMachineOptions: async (settings) =>
          settings.region === "test"
            ? previousCatalog.promise
            : [{ id: "large", label: "Large", cpu: 8, default: true }],
        listOperatingSystems: async () => [{ id: "linux", label: "Linux", default: true }],
      }),
    );
    await service.prepareProjectIntent("development");
    support.getDevelopmentProfile().settings = { region: "replacement" };
    const intent = await service.prepareProjectIntent("development");
    const environment = support.testState.store.createIntent({
      environmentId: "replacement-worker",
      providerId: intent.providerId,
      profileId: "development",
      profileSnapshot: intent.profileSnapshot,
      provisionOperationId: "provision:replacement",
    });
    try {
      await support.waitForFast(() =>
        expect(service.readMachineShape(environment.environmentId)).toEqual({
          class: "large",
          cpu: 8,
          os: "linux",
          osLabel: "Linux",
        }),
      );
    } finally {
      previousCatalog.resolve([{ id: "small", label: "Small", cpu: 2, default: true }]);
    }
    await previousCatalog.promise;
    expect(service.readMachineShape(environment.environmentId)).toEqual({
      class: "large",
      cpu: 8,
      os: "linux",
      osLabel: "Linux",
    });
  });

  it("keeps allocation and available OS metadata when machine discovery fails", async () => {
    const warn = vi.fn();
    const service = support.createService(
      support.createProvider({
        listMachineOptions: async () => {
          throw new Error("catalog unavailable");
        },
        listOperatingSystems: async () => [{ id: "linux", label: "Linux", default: true }],
      }),
      { logger: { warn } },
    );
    service.subscribeMachineShapeChanged(() => {
      throw new Error("observer unavailable");
    });
    const environment = await service.create("development", "catalog-failure");
    expect(environment.state).toBe("ready");
    await support.waitForFast(() =>
      expect(warn).toHaveBeenCalledWith(
        "Worker machine catalog warmup failed for profile development",
      ),
    );
    expect(service.readMachineShape(environment.environmentId)).toEqual({
      os: "linux",
      osLabel: "Linux",
    });
    await expect(service.listOperatingSystems("development")).resolves.toEqual([
      { id: "linux", label: "Linux", default: true },
    ]);
    expect(warn).toHaveBeenCalledWith("Worker machine metadata change reporting failed");
  });

  it.each([
    [
      "duplicate ids",
      [
        { id: "fast", label: "Fast" },
        { id: "fast", label: "Faster" },
      ],
    ],
    ["blank ids", [{ id: " ", label: "Fast" }]],
    ["untrimmed OS ids", [{ id: "fast", label: "Fast", os: " os-a" }]],
    [
      "duplicate per-OS ids",
      [
        { id: "fast", label: "Fast", os: "os-a" },
        { id: "fast", label: "Faster", os: "os-a" },
      ],
    ],
    [
      "multiple defaults for one OS",
      [
        { id: "standard", label: "Standard", default: true, os: "os-a" },
        { id: "fast", label: "Fast", default: true, os: "os-a" },
      ],
    ],
    ["malformed labels", [{ id: "fast", label: 16 }]],
    ["non-positive CPU counts", [{ id: "fast", label: "Fast", cpu: 0 }]],
    ["non-integer memory sizes", [{ id: "fast", label: "Fast", memoryGb: 63.5 }]],
    ["implausible memory sizes", [{ id: "fast", label: "Fast", memoryGb: 65_537 }]],
    [
      "multiple defaults",
      [
        { id: "standard", label: "Standard", default: true },
        { id: "fast", label: "Fast", default: true },
      ],
    ],
    [
      "over-limit catalogs",
      Array.from({ length: 65 }, (_, index) => ({ id: `machine-${index}`, label: "Machine" })),
    ],
  ])("omits %s returned by a worker provider", async (_name, options) => {
    const provider = support.createProvider();
    Object.defineProperty(provider, "listMachineOptions", { value: async () => options });
    const workerService = support.createService(provider);

    await expect(workerService.listMachineOptions("development")).resolves.toBeUndefined();
  });

  it.each(
    [
      [],
      [
        { id: "os-a", label: "OS A" },
        { id: "os-a", label: "Duplicate" },
      ],
      [
        { id: "os-a", label: "OS A", default: true },
        { id: "os-b", label: "OS B", default: true },
      ],
      [{ id: " os-a", label: "OS A" }],
      [{ id: "os-a", label: " OS A" }],
      [{ id: "os-a", label: "OS A", disabledReason: "" }],
      [{ id: "os-a", label: "OS A", disabledReason: " " }],
      [{ id: "os-a", label: "OS A", disabledReason: "x".repeat(257) }],
      [{ id: "os-a", label: "OS A", settings: {} }],
      Array.from({ length: 9 }, (_, index) => ({ id: `os-${index}`, label: "OS" })),
    ].map((systems) => ({ systems })),
  )("omits malformed operating-system catalog %#", async ({ systems }) => {
    const provider = support.createProvider();
    Object.defineProperty(provider, "listOperatingSystems", { value: async () => systems });
    const workerService = support.createService(provider);
    await expect(workerService.listOperatingSystems("development")).resolves.toBeUndefined();
  });

  it("creates a nested environment from its parent's snapshot after config drift", async () => {
    const provisionedProfiles: WorkerProfile[] = [];
    const operatingSystems: Array<string | undefined> = [];
    let lease = 0;
    let credential = 0;
    const workerService = support.createService(
      support.createProvider({
        provision: async (profile, _operationId, options) => {
          provisionedProfiles.push(structuredClone(profile));
          operatingSystems.push(options?.os);
          lease += 1;
          return { leaseId: `lease-${lease}`, ssh: support.SSH_ENDPOINT };
        },
      }),
      {
        generateWorkerCredential: () => `nested-worker-credential-${(credential += 1)}`,
      },
    );
    const parent = await workerService.create(
      "development",
      "parent-profile-snapshot",
      undefined,
      undefined,
      undefined,
      undefined,
      "os-a",
    );
    support.getDevelopmentProfile().settings = { region: "mutated" };
    support.getDevelopmentProfile().provider = "FaKe";

    const inherited = {
      profileId: parent.profileId,
      providerId: parent.providerId,
      profileSnapshot: parent.profileSnapshot,
    };
    const child = await workerService.createFromProfileSnapshot(
      inherited,
      "child-profile-snapshot",
    );

    expect(provisionedProfiles).toEqual([{ region: "test" }, { region: "test" }]);
    expect(operatingSystems).toEqual(["os-a", "os-a"]);
    expect(child).toMatchObject({
      profileId: parent.profileId,
      providerId: parent.providerId,
      profileSnapshot: parent.profileSnapshot,
    });
    await expect(
      workerService.createFromProfileSnapshot(inherited, "child-profile-snapshot"),
    ).resolves.toMatchObject({ environmentId: child.environmentId });
    await expect(
      workerService.createFromProfileSnapshot(
        inherited,
        "child-profile-snapshot",
        undefined,
        undefined,
        undefined,
        undefined,
        "os-b",
      ),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(operatingSystems).toHaveLength(2);
  });

  it.each([
    {
      name: "removed",
      mutate: () => {
        support.testState.config.cloudWorkers = { profiles: {} };
      },
      code: "profile_not_found",
    },
    {
      name: "assigned to a different provider",
      mutate: () => {
        support.getDevelopmentProfile().provider = "replacement";
      },
      code: "invalid_profile",
    },
  ])("rejects a fresh inherited environment when its profile was $name", async (testCase) => {
    let lease = 0;
    let credential = 0;
    const provision = vi.fn(async () => ({
      leaseId: `inherited-lease-${(lease += 1)}`,
      ssh: support.SSH_ENDPOINT,
    }));
    const workerService = support.createService(support.createProvider({ provision }), {
      generateWorkerCredential: () => `inherited-worker-credential-${(credential += 1)}`,
    });
    const parent = await workerService.create("development", "parent-inherited-profile");
    const inherited = {
      profileId: parent.profileId,
      providerId: parent.providerId,
      profileSnapshot: parent.profileSnapshot,
    };
    testCase.mutate();

    await expect(
      workerService.createFromProfileSnapshot(inherited, "fresh-inherited-profile"),
    ).rejects.toMatchObject({ code: testCase.code });
    expect(provision).toHaveBeenCalledOnce();
    expect(support.testState.store.list()).toHaveLength(1);

    await expect(
      workerService.createFromProfileSnapshot(inherited, "parent-inherited-profile"),
    ).resolves.toMatchObject({ environmentId: parent.environmentId });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("allows paired-device placement without configured cloud profiles", async () => {
    support.testState.config.cloudWorkers = { profiles: {} };
    const provision = vi.fn(async () => ({
      leaseId: "device-lease",
      node: { deviceId: "device-1" },
    }));
    const workerService = support.createService(
      support.createProvider({
        id: DEVICE_WORKER_PROVIDER_ID,
        supportedExecutionModes: ["worker-turn"],
        provision,
      }),
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );

    await expect(
      workerService.createFromProfileSnapshot(
        {
          profileId: "device:device-1",
          providerId: DEVICE_WORKER_PROVIDER_ID,
          profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
        },
        "paired-profileless",
        undefined,
        "worker-turn",
      ),
    ).resolves.toMatchObject({ state: "ready", nodeDeviceId: "device-1" });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("revokes removed configured device profiles without disabling synthetic paired devices", async () => {
    let lease = 0;
    let credential = 0;
    const profile = support.getDevelopmentProfile();
    profile.provider = DEVICE_WORKER_PROVIDER_ID;
    profile.settings = { device: "device-1" };
    const provision = vi.fn(async () => ({
      leaseId: `named-device-lease-${(lease += 1)}`,
      node: { deviceId: "device-1" },
    }));
    const workerService = support.createService(
      support.createProvider({
        id: DEVICE_WORKER_PROVIDER_ID,
        supportedExecutionModes: ["worker-turn"],
        provision,
      }),
      {
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
        generateWorkerCredential: () => `named-device-credential-${(credential += 1)}`,
      },
    );
    const parent = await workerService.create(
      "development",
      "named-device-parent",
      undefined,
      "worker-turn",
    );
    support.testState.config.cloudWorkers = { profiles: {} };

    await expect(
      workerService.createFromProfileSnapshot(
        {
          profileId: parent.profileId,
          providerId: parent.providerId,
          profileSnapshot: parent.profileSnapshot,
        },
        "named-device-child",
        undefined,
        "worker-turn",
      ),
    ).rejects.toMatchObject({ code: "profile_not_found" });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("rejects plaintext secret fields before persisting intent", async () => {
    support.getDevelopmentProfile().settings = {
      keyRef: "not-a-secret-ref",
    };
    const provision = vi.fn(support.createProvider().provision);

    await expect(
      support
        .createService(support.createProvider({ provision }))
        .create("development", "request-secret"),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("records permanent provider profile rejection as terminal", async () => {
    let provisionCalls = 0;
    const provider = support.createProvider({
      provision: async () => {
        provisionCalls += 1;
        throw new WorkerProviderError("region is required");
      },
    });
    const workerService = support.createService(provider);

    await expect(workerService.create("development", "request-invalid")).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("region is required"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const record = expectDefined(
      support.testState.store.list()[0],
      "store.list()[0] test invariant",
    );
    expect(record).toMatchObject({ state: "failed", lastError: "region is required" });

    await workerService.reconcileOnce();
    await expect(workerService.destroy(record.environmentId)).resolves.toMatchObject({
      state: "failed",
    });
    expect(provisionCalls).toBe(1);
  });

  it("rejects non-canonical profile ids before persistence", async () => {
    const workerService = support.createService(support.createProvider());

    await expect(workerService.create(" development ", "request-spaced")).rejects.toMatchObject({
      code: "invalid_profile",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()).toEqual([]);
  });

  it.each(["direct destroy", "restart reconcile"] as const)(
    "cancels a requested intent without allocating on %s",
    async (mode) => {
      const intent = support.testState.store.createIntent({
        environmentId: `worker-cancel-${mode}`,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: `provision:cancel-${mode}`,
      });
      const provision = vi.fn(support.createProvider().provision);
      const workerService = support.createService(support.createProvider({ provision }));

      if (mode === "direct destroy") {
        await workerService.destroy(intent.environmentId);
      } else {
        support.testState.store.requestDestroy({
          environmentId: intent.environmentId,
          state: "requested",
        });
        support.testState.providersEnabled = false;
        await workerService.reconcileOnce();
      }

      expect(provision).not.toHaveBeenCalled();
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "failed",
        lastError: "Provisioning canceled before provider allocation",
        destroyRequestedAtMs: expect.any(Number),
      });
    },
  );
});
