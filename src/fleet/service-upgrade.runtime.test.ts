import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { getFleetCell } from "./registry.js";
import {
  createContainerMock,
  createFleetService,
  fleetLabels,
  NEXT_ATTEMPT_ID,
  runningInspection,
  setFleetSuiteRoot,
} from "./service.runtime.test-helpers.js";

describe("fleet service upgrade and restore", () => {
  let env: NodeJS.ProcessEnv;

  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-fleet-service-upgrade-" });

  beforeEach(async () => {
    const root = await tempRoot.setup();
    setFleetSuiteRoot(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
    );
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllGlobals();
    await tempRoot.cleanup();
  });

  it.each([
    {
      name: "generated previous default",
      cache: "/home/node/.cache",
      keys: "FEATURE",
      expectedCache: "/home/node/.openclaw/cache",
    },
    {
      name: "explicit matching default",
      cache: "/home/node/.openclaw/cache",
      keys: "FEATURE,XDG_CACHE_HOME",
      expectedCache: "/home/node/.openclaw/cache",
    },
    {
      name: "explicit previous default",
      cache: "/home/node/.cache",
      keys: "FEATURE,XDG_CACHE_HOME",
      expectedCache: "/home/node/.cache",
    },
  ])("carries resources and $name through upgrade", async ({ cache, keys, expectedCache }) => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
      now: () => 1000,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    // The disk limit replays from the fleet label because Podman inspect has no
    // HostConfig.StorageOpt; the label is the cross-runtime carrier.
    const diskLabels = {
      ...fleetLabels(),
      "openclaw.fleet.disk-limit": "10g",
      "openclaw.fleet.env-keys": keys,
    };
    const upgradedEnvironment = {
      ...runningInspection().environment,
      XDG_CACHE_HOME: cache,
    };
    containers.inspect
      .mockResolvedValue(
        runningInspection({ labels: diskLabels, environment: upgradedEnvironment }),
      )
      .mockResolvedValueOnce(
        runningInspection({ labels: diskLabels, environment: upgradedEnvironment }),
      )
      .mockResolvedValueOnce(runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) }));

    const result = await service.upgrade("acme", "ghcr.io/openclaw/openclaw:v2");

    expect(result).toEqual({
      tenant: "acme",
      action: "upgrade",
      image: "ghcr.io/openclaw/openclaw:v2",
    });
    expect(containers.pull).toHaveBeenCalledWith("docker", "ghcr.io/openclaw/openclaw:v2");
    expect(containers.stop).toHaveBeenCalledWith("docker", "container-id");
    expect(containers.remove).toHaveBeenCalledWith("docker", "container-id", false);
    expect(containers.inspectNetwork).toHaveBeenCalledWith("docker", "openclaw-cell-acme-net");
    const [profile, start] = containers.run.mock.calls[0] ?? [];
    expect(start).toBe(true);
    expect(profile).toMatchObject({
      image: "ghcr.io/openclaw/openclaw:v2",
      hostPort: 19_100,
      memory: "2147483648",
      cpus: "2",
      pidsLimit: 512,
      diskSize: "10g",
      networkName: "openclaw-cell-acme-net",
      environment: {
        HOME: "/home/node",
        OPENCLAW_GATEWAY_TOKEN: "old-token",
        FEATURE: "enabled",
        XDG_CACHE_HOME: expectedCache,
      },
      userEnvironmentKeys: keys.split(","),
    });
    expect(profile?.environment).not.toHaveProperty("NODE_VERSION");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:v2");
  });

  it("passes digest-pinned images verbatim to create and upgrade", async () => {
    const containers = createContainerMock();
    const digest = `ghcr.io/openclaw/openclaw@sha256:${"a".repeat(64)}`;
    const service = createFleetService({
      env,
      containers: containers.runtime,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });

    await service.create({ tenant: "acme", image: digest, gatewayToken: "old-token" });
    expect(containers.run.mock.calls[0]?.[0].image).toBe(digest);

    containers.run.mockClear();
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) }));
    await service.upgrade("acme");

    expect(containers.pull).toHaveBeenCalledWith("docker", digest);
    expect(containers.run.mock.calls[0]?.[0].image).toBe(digest);
  });

  it("restores the immutable old image when replacement fails", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce({ kind: "missing", state: "missing" });
    containers.run.mockRejectedValueOnce(new Error("replacement failed")).mockResolvedValueOnce();

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("restarts the old cell when removal fails after stop", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    containers.start.mockClear();
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(runningInspection({ state: "exited", running: false }));
    containers.remove.mockRejectedValueOnce(new Error("daemon busy"));

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.stop).toHaveBeenCalledWith("docker", "container-id");
    expect(containers.start).toHaveBeenCalledWith("docker", "container-id");
    expect(containers.run).not.toHaveBeenCalled();
  });

  it("restores the old cell when the replacement registry update fails", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
      now: () => 1000,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
      updateImage: () => {
        throw new Error("state database is full");
      },
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    containers.remove.mockClear();
    // The replacement carries its own container id, so the recovery removal is
    // only correct if it targets the generation the attempt label identified.
    const replacement = runningInspection({
      containerId: "replacement-container-id",
      labels: fleetLabels("acme", NEXT_ATTEMPT_ID),
    });
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(replacement);

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(containers.remove).toHaveBeenCalledWith("docker", "replacement-container-id", true);
    expect(containers.removeNetwork).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("restores the previous cell when the replacement container is not running", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    const crashLooping = runningInspection({
      labels: fleetLabels("acme", NEXT_ATTEMPT_ID),
      state: "restarting",
      running: false,
    });
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(crashLooping)
      .mockResolvedValueOnce(crashLooping);

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("restores the previous cell when the replacement crashes after starting", async () => {
    const containers = createContainerMock();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValue(new Error("connect ECONNREFUSED"));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      sleep: async () => {},
      now: () => 1000,
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    const crashed = runningInspection({
      labels: fleetLabels("acme", NEXT_ATTEMPT_ID),
      state: "exited",
      running: false,
    });
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) }))
      .mockResolvedValueOnce(crashed)
      .mockResolvedValueOnce(crashed);

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("restores the previous cell when the replacement never becomes healthy", async () => {
    const containers = createContainerMock();
    let clock = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      sleep: async () => {},
      now: () => (clock += 50_000),
      generateAttemptId: () => NEXT_ATTEMPT_ID,
    });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.run.mockClear();
    const hung = runningInspection({ labels: fleetLabels("acme", NEXT_ATTEMPT_ID) });
    containers.inspect
      .mockResolvedValueOnce(runningInspection())
      .mockResolvedValueOnce(hung)
      .mockResolvedValueOnce(hung)
      .mockResolvedValueOnce(hung);

    await expect(service.upgrade("acme")).rejects.toThrow(/previous container was restored/iu);

    expect(containers.run).toHaveBeenCalledTimes(2);
    expect(containers.run.mock.calls[1]?.[0].image).toBe("sha256:old-image-id");
    expect(getFleetCell(env, "acme")?.image).toBe("ghcr.io/openclaw/openclaw:latest");
  });

  it("refuses upgrade before pull or removal when the inspected token is missing", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.inspect.mockResolvedValue(
      runningInspection({ environment: { HOME: "/home/node" } }),
    );

    await expect(service.upgrade("acme")).rejects.toThrow(/no Gateway token environment/iu);
    expect(containers.pull).not.toHaveBeenCalled();
    expect(containers.stop).not.toHaveBeenCalled();
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("refuses upgrade when an unexpected container is attached to the cell network", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "old-token" });
    containers.inspect.mockResolvedValue(runningInspection());
    containers.inspectNetwork.mockResolvedValue({
      kind: "ok",
      labels: fleetLabels(),
      attachedContainers: [
        { id: "cell-id", name: "openclaw-cell-acme" },
        { id: "peer-id", name: "unexpected-peer" },
      ],
      internal: false,
    });

    await expect(service.upgrade("acme")).rejects.toThrow(/unexpected containers/iu);
    expect(containers.pull).toHaveBeenCalledOnce();
    expect(containers.stop).not.toHaveBeenCalled();
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("rejects option-like images before create or upgrade mutations", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(
      service.create({ tenant: "bad-image", image: "--help", gatewayToken: "token" }),
    ).rejects.toThrow(/image must not begin/iu);
    expect(getFleetCell(env, "bad-image")).toBeUndefined();
    expect(containers.run).not.toHaveBeenCalled();

    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());
    await expect(service.upgrade("acme", "--help")).rejects.toThrow(/image must not begin/iu);
    expect(containers.pull).not.toHaveBeenCalled();
    expect(containers.stop).not.toHaveBeenCalled();
    expect(containers.remove).not.toHaveBeenCalled();
  });
});
