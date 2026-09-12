import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { cellAuthSecretDir, cellOwnerId } from "./cell-profile.js";
import type { FleetContainerInspectResult } from "./containers.runtime.js";
import { deleteFleetCell, getFleetCell, listFleetCells } from "./registry.js";
import {
  createContainerMock,
  createFleetService,
  fleetLabels,
  runningInspection,
  setFleetSuiteRoot,
  TEST_ATTEMPT_ID,
} from "./service.runtime.test-helpers.js";

let root: string;

describe("fleet service", () => {
  let env: NodeJS.ProcessEnv;

  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-fleet-service-" });

  beforeEach(async () => {
    root = await tempRoot.setup();
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

  it("creates a bootable token-only cell config and returns the secret-bearing result", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1_700_000_000_000,
      generateToken: () => "gw-token",
    });

    const result = await service.create({
      tenant: "acme",
      env: ["FEATURE=a=b"],
    });

    expect(result).toEqual({
      tenant: "acme",
      containerName: "openclaw-cell-acme",
      port: 19_100,
      image: "ghcr.io/openclaw/openclaw:latest",
      runtime: "docker",
      started: true,
      token: "gw-token",
      tokenNote: "Shown once. Store this Gateway token securely.",
      url: "http://127.0.0.1:19100",
      nextStep:
        "Open http://127.0.0.1:19100, then configure per-tenant channel accounts inside the cell.",
    });
    expect(containers.run).toHaveBeenCalledOnce();
    const [profile, start] = containers.run.mock.calls[0] ?? [];
    expect(start).toBe(false);
    expect(containers.createNetwork).toHaveBeenCalledWith(
      "docker",
      "openclaw-cell-acme-net",
      {
        "openclaw.fleet.tenant": "acme",
        "openclaw.fleet.owner": cellOwnerId(path.join(root, "fleet", "cells", "acme")),
        "openclaw.fleet.attempt": expect.stringMatching(/^[a-f0-9]{32}$/u),
      },
      { internal: false },
    );
    expect(containers.start).toHaveBeenCalledWith("docker", "openclaw-cell-acme");
    expect(profile?.networkName).toBe("openclaw-cell-acme-net");
    expect(containers.createNetwork.mock.invocationCallOrder[0] ?? -1).toBeLessThan(
      containers.run.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(containers.run.mock.invocationCallOrder[0] ?? -1).toBeLessThan(
      containers.start.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(profile?.environment).toMatchObject({
      OPENCLAW_GATEWAY_TOKEN: "gw-token",
      FEATURE: "a=b",
    });
    expect(profile?.userEnvironmentKeys).toEqual(["FEATURE"]);

    const dataDir = path.join(root, "fleet", "cells", "acme");
    const config = JSON.parse(await fs.readFile(path.join(dataDir, "openclaw.json"), "utf8")) as {
      gateway?: {
        mode?: string;
        bind?: string;
        auth?: Record<string, unknown>;
        controlUi?: { allowedOrigins?: string[] };
      };
    };
    expect(config.gateway).toMatchObject({
      mode: "local",
      bind: "lan",
      auth: { mode: "token" },
      controlUi: {
        allowedOrigins: ["http://localhost:19100", "http://127.0.0.1:19100"],
      },
    });
    expect(config.gateway?.auth).not.toHaveProperty("token");
    const authSecretDir = cellAuthSecretDir(root, "acme");
    await expect(fs.stat(authSecretDir)).resolves.toBeDefined();
    expect(path.relative(dataDir, authSecretDir)).toMatch(/^\.\./u);
  });

  it("generates a 32-character hexadecimal token", async () => {
    const containers = createContainerMock();
    const result = await createFleetService({ env, containers: containers.runtime }).create({
      tenant: "random-token",
      start: false,
    });

    expect(result.token).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("health-gates started creates and skips the gate with --no-start", async () => {
    const containers = createContainerMock();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      probePort: async () => true,
    });

    await expect(
      service.create({ tenant: "healthy", gatewayToken: "token" }),
    ).resolves.toMatchObject({ tenant: "healthy", started: true });
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    await expect(
      service.create({ tenant: "stopped", gatewayToken: "token", start: false }),
    ).resolves.toMatchObject({ tenant: "stopped", started: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an unhealthy created cell and its runtime evidence", async () => {
    const containers = createContainerMock();
    let clock = 0;
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
      now: () => (clock += 50_000),
      sleep: async () => {},
      probePort: async () => true,
    });

    await expect(service.create({ tenant: "sick", gatewayToken: "token" })).rejects.toThrow(
      "Fleet cell sick was created but did not become healthy within 60s; inspect it with `openclaw fleet status sick` or `openclaw fleet logs sick`, or remove it with `openclaw fleet rm sick --force`.",
    );

    expect(getFleetCell(env, "sick")).toBeDefined();
    expect(containers.remove).not.toHaveBeenCalled();
    expect(containers.removeNetwork).not.toHaveBeenCalled();
  });

  it("rejects busy explicit ports before reservation and propagates probe errors", async () => {
    const containers = createContainerMock();
    const busy = createFleetService({
      env,
      containers: containers.runtime,
      probePort: async () => false,
    });
    await expect(
      busy.create({ tenant: "busy", port: 20_000, gatewayToken: "token" }),
    ).rejects.toThrow("Host port 20000 is already in use on 127.0.0.1 by another process.");
    expect(getFleetCell(env, "busy")).toBeUndefined();

    const failure = new Error("bind permission denied");
    const broken = createFleetService({
      env,
      containers: containers.runtime,
      probePort: async () => {
        throw failure;
      },
    });
    await expect(broken.create({ tenant: "broken", gatewayToken: "token" })).rejects.toBe(failure);
    expect(getFleetCell(env, "broken")).toBeUndefined();
  });

  it("skips probe-busy ports during automatic allocation", async () => {
    const containers = createContainerMock();
    const probePort = vi.fn(async (port: number) => port !== 19_100);
    const service = createFleetService({ env, containers: containers.runtime, probePort });

    const result = await service.create({ tenant: "acme", gatewayToken: "token" });

    expect(probePort.mock.calls.map(([port]) => port)).toEqual([19_100, 19_101]);
    expect(result.port).toBe(19_101);
    expect(getFleetCell(env, "acme")?.hostPort).toBe(19_101);
  });

  it("keeps scanning past long busy runs instead of capping attempts", async () => {
    const containers = createContainerMock();
    const probePort = vi.fn(async (port: number) => port >= 19_130);
    const service = createFleetService({ env, containers: containers.runtime, probePort });

    const result = await service.create({ tenant: "acme", gatewayToken: "token" });

    expect(result.port).toBe(19_130);
    expect(probePort).toHaveBeenCalledTimes(31);
  });

  it("retries automatic allocation when another tenant reserves the probed port", async () => {
    const containers = createContainerMock();
    let releaseFirstProbes: (() => void) | undefined;
    let firstProbeCount = 0;
    const firstProbes = new Promise<void>((resolve) => {
      releaseFirstProbes = resolve;
    });
    const probePort = vi.fn(async (port: number) => {
      if (port === 19_100 && (firstProbeCount += 1) < 2) {
        await firstProbes;
      } else if (port === 19_100) {
        releaseFirstProbes?.();
      }
      return true;
    });
    const service = createFleetService({ env, containers: containers.runtime, probePort });

    const [alpha, beta] = await Promise.all([
      service.create({ tenant: "alpha", gatewayToken: "alpha-token" }),
      service.create({ tenant: "beta", gatewayToken: "beta-token" }),
    ]);

    expect(new Set([alpha.port, beta.port])).toEqual(new Set([19_100, 19_101]));
    expect(
      listFleetCells(env)
        .map((cell) => cell.hostPort)
        .toSorted((left, right) => left - right),
    ).toEqual([19_100, 19_101]);
  });

  it("threads disk and Podman internal networking into provisioning", async () => {
    const containers = createContainerMock();
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })),
      now: () => 1000,
    });
    await service.create({
      tenant: "acme",
      runtime: "podman",
      disk: "10g",
      network: "internal",
      gatewayToken: "token",
    });
    expect(containers.run.mock.calls[0]?.[0]).toMatchObject({ diskSize: "10g" });
    expect(containers.createNetwork).toHaveBeenCalledWith(
      "podman",
      "openclaw-cell-acme-net",
      expect.any(Object),
      { internal: true },
    );
  });

  it("rejects Docker internal networking before reservation", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime });
    await expect(
      service.create({ tenant: "acme", network: "internal", gatewayToken: "token" }),
    ).rejects.toThrow(/Docker cannot publish loopback ports/iu);
    expect(getFleetCell(env, "acme")).toBeUndefined();
    expect(containers.createNetwork).not.toHaveBeenCalled();
  });

  it("wraps unsupported disk errors after rolling back the reservation", async () => {
    const containers = createContainerMock();
    containers.run.mockRejectedValue(new Error("--storage-opt is supported only with pquota"));
    const service = createFleetService({ env, containers: containers.runtime });
    await expect(
      service.create({ tenant: "acme", disk: "10g", gatewayToken: "token" }),
    ).rejects.toThrow(/Fleet cannot enforce --disk.*XFS/iu);
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("rejects a remote runtime before registry or filesystem mutation", async () => {
    const containers = createContainerMock();
    containers.assertLocal.mockRejectedValue(
      new Error("Fleet requires a local Docker endpoint; remote cells are not supported."),
    );
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "remote", gatewayToken: "token" })).rejects.toThrow(
      /local Docker endpoint.*remote cells/iu,
    );

    expect(getFleetCell(env, "remote")).toBeUndefined();
    expect(containers.createNetwork).not.toHaveBeenCalled();
    expect(containers.run).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "fleet", "cells", "remote"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lists cells deterministically and degrades runtime failures to unknown", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "zulu", gatewayToken: "z-token" });
    await service.create({ tenant: "alpha", gatewayToken: "a-token" });
    containers.inspect.mockImplementation(async (_runtime, name) =>
      name.endsWith("alpha")
        ? runningInspection({ labels: fleetLabels("alpha") })
        : { kind: "unavailable", state: "unknown", error: "daemon unavailable" },
    );

    const cells = await service.list();

    expect(cells.map((cell) => [cell.tenant, cell.state])).toEqual([
      ["alpha", "running"],
      ["zulu", "unknown"],
    ]);
    expect(JSON.stringify(cells)).not.toContain("old-token");
  });

  it("reports live status with a bounded loopback health probe", async () => {
    const containers = createContainerMock();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      now: () => 1000,
    });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());

    const status = await service.status("acme");

    expect(status.container).toEqual({
      state: "running",
      running: true,
      managed: true,
      imageId: "sha256:old-image-id",
    });
    expect(status.health).toEqual({
      status: "ok",
      url: "http://127.0.0.1:19100/healthz",
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:19100/healthz",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(JSON.stringify(status)).not.toContain("old-token");
  });

  it("reports failed and skipped health outcomes without probing a stopped cell", async () => {
    const containers = createContainerMock();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      fetch: fetchMock,
      now: () => 1000,
    });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    fetchMock.mockClear();
    containers.inspect.mockResolvedValue(runningInspection({ state: "exited", running: false }));

    await expect(service.status("acme")).resolves.toMatchObject({
      health: { status: "skipped", reason: "container is not running" },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    containers.inspect.mockResolvedValue(runningInspection());
    await expect(service.status("acme")).resolves.toMatchObject({
      health: { status: "failed", httpStatus: 503, error: "HTTP 503" },
    });
  });

  it("omits imageId for missing and unmanaged status", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });

    containers.inspect.mockResolvedValue(runningInspection({ labels: {} }));
    expect((await service.status("acme")).container).not.toHaveProperty("imageId");
    containers.inspect.mockResolvedValue({ kind: "missing", state: "missing" });
    expect((await service.status("acme")).container).not.toHaveProperty("imageId");
  });

  it.each(["start", "stop", "restart"] as const)("runs the %s lifecycle action", async (action) => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());
    containers[action].mockClear();

    await expect(service.lifecycle("acme", action)).resolves.toEqual({ tenant: "acme", action });

    expect(containers[action]).toHaveBeenCalledWith("docker", "container-id");
  });

  it("pins logs to the inspected container generation after proving ownership", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());

    const logOptions = { tenant: "acme", follow: true, timestamps: true, tail: 100, since: "10m" };
    await expect(service.logs(logOptions)).resolves.toBeUndefined();

    expect(containers.logs).toHaveBeenCalledWith("docker", "container-id", {
      follow: true,
      timestamps: true,
      tail: 100,
      since: "10m",
      redactValues: ["old-token"],
    });
  });

  it.each(["foreign", "missing", "unavailable"] as const)(
    "refuses %s log inspection before streaming",
    async (kind) => {
      const inspection: FleetContainerInspectResult =
        kind === "foreign"
          ? runningInspection({ labels: {} })
          : kind === "missing"
            ? { kind: "missing", state: "missing" }
            : { kind: "unavailable", state: "unknown", error: "daemon unavailable" };
      const containers = createContainerMock();
      const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
      await service.create({ tenant: "acme", gatewayToken: "token" });
      containers.inspect.mockResolvedValue(inspection);

      await expect(service.logs({ tenant: "acme" })).rejects.toThrow();
      expect(containers.logs).not.toHaveBeenCalled();
    },
  );

  it("refuses logs when the recorded runtime is unavailable", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockClear();
    containers.assertLocal.mockRejectedValue(new Error("daemon unavailable"));

    await expect(service.logs({ tenant: "acme" })).rejects.toThrow(/daemon unavailable/iu);
    expect(containers.inspect).not.toHaveBeenCalled();
    expect(containers.logs).not.toHaveBeenCalled();
  });

  it("requires force for running removal and purge", async () => {
    const containers = createContainerMock();
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    await service.create({ tenant: "acme", gatewayToken: "token" });
    containers.inspect.mockResolvedValue(runningInspection());

    await expect(service.remove({ tenant: "acme" })).rejects.toThrow(/running.*--force/iu);
    await expect(service.remove({ tenant: "acme", purgeData: true })).rejects.toThrow(
      "--purge-data requires --force.",
    );
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("removes a labeled partial container before releasing a failed create", async () => {
    const containers = createContainerMock(runningInspection());
    containers.run.mockRejectedValue(new Error("host port is already allocated"));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already allocated/iu,
    );

    expect(containers.remove).toHaveBeenCalledWith("docker", "container-id", true);
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("releases a failed-create reservation when a foreign container takes the freed name", async () => {
    const containers = createContainerMock(runningInspection());
    containers.run.mockRejectedValue(new Error("host port is already allocated"));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });
    // The partial container is removed by id; an unrelated container then claims
    // the freed cell name. Cleanup is complete, so the reservation must go.
    containers.remove.mockImplementation(async () => {
      containers.inspect.mockImplementation(async (_runtime, reference) =>
        reference === "container-id"
          ? { kind: "missing", state: "missing" }
          : runningInspection({ containerId: "foreign-id", labels: {} }),
      );
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already allocated/iu,
    );

    expect(containers.remove).toHaveBeenCalledWith("docker", "container-id", true);
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("retains a failed-create reservation when partial cleanup is uncertain", async () => {
    const containers = createContainerMock({
      kind: "unavailable",
      state: "unknown",
      error: "daemon unavailable",
    });
    containers.run.mockRejectedValue(new Error("container command timed out"));
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /timed out/iu,
    );

    expect(containers.remove).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeDefined();
  });

  it("cleans up its exact-attempt network when network creation fails", async () => {
    const containers = createContainerMock();
    containers.createNetwork.mockRejectedValue(new Error("network create timed out"));
    containers.inspectNetwork
      .mockResolvedValueOnce({
        kind: "ok",
        labels: fleetLabels(),
        attachedContainers: [],
        internal: false,
      })
      .mockResolvedValueOnce({ kind: "missing" });
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /timed out/iu,
    );

    expect(containers.run).not.toHaveBeenCalled();
    expect(containers.removeNetwork).toHaveBeenCalledWith("docker", "openclaw-cell-acme-net");
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("serializes same-tenant mutations across service instances", async () => {
    const containers = createContainerMock();
    let releaseNetwork: (() => void) | undefined;
    containers.createNetwork.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          releaseNetwork = resolve;
        }),
    );
    const first = createFleetService({ env, containers: containers.runtime, now: () => 1000 });
    const second = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    const creating = first.create({ tenant: "acme", gatewayToken: "token" });
    await vi.waitFor(() => expect(containers.createNetwork).toHaveBeenCalledOnce());
    await expect(second.create({ tenant: "acme", gatewayToken: "other-token" })).rejects.toThrow(
      /fleet create.*already running/iu,
    );

    releaseNetwork?.();
    await expect(creating).resolves.toMatchObject({ tenant: "acme" });
  });

  it("releases a failed operation lease for a retry", async () => {
    const containers = createContainerMock();
    containers.createNetwork.mockRejectedValueOnce(new Error("daemon busy"));
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /daemon busy/iu,
    );
    await expect(
      service.create({ tenant: "acme", gatewayToken: "retry-token" }),
    ).resolves.toMatchObject({ tenant: "acme" });
  });

  it("removes its exact-attempt container when the reservation disappears mid-create", async () => {
    const containers = createContainerMock(runningInspection({ state: "created", running: false }));
    containers.run.mockImplementation(async () => {
      deleteFleetCell(env, "acme");
    });
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /reservation changed/iu,
    );

    expect(containers.remove).toHaveBeenCalledWith("docker", "container-id", true);
    expect(containers.start).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("releases the reservation when an unlabeled foreign container holds the cell name", async () => {
    const containers = createContainerMock(runningInspection({ labels: {} }));
    containers.run.mockRejectedValue(new Error("container name is already in use"));
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already in use/iu,
    );

    expect(containers.remove).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("releases the reservation when an unlabeled foreign network holds the cell name", async () => {
    const containers = createContainerMock();
    containers.createNetwork.mockRejectedValue(new Error("network name is already in use"));
    containers.inspectNetwork.mockResolvedValue({
      kind: "ok",
      labels: {},
      attachedContainers: [],
      internal: false,
    });
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already in use/iu,
    );

    expect(containers.removeNetwork).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("never removes a same-tenant container owned by another profile", async () => {
    const containers = createContainerMock(
      runningInspection({
        labels: {
          ...fleetLabels(),
          "openclaw.fleet.owner": "11111111111111111111111111111111",
        },
      }),
    );
    containers.run.mockRejectedValue(new Error("container name is already in use"));
    const service = createFleetService({ env, containers: containers.runtime, now: () => 1000 });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already in use/iu,
    );

    expect(containers.remove).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeUndefined();
  });

  it("never removes a same-profile container that predates the create attempt", async () => {
    const containers = createContainerMock(
      runningInspection({
        labels: fleetLabels("acme", "33333333333333333333333333333333"),
      }),
    );
    containers.run.mockRejectedValue(new Error("container name is already in use"));
    const service = createFleetService({
      env,
      containers: containers.runtime,
      now: () => 1000,
      generateAttemptId: () => TEST_ATTEMPT_ID,
    });

    await expect(service.create({ tenant: "acme", gatewayToken: "token" })).rejects.toThrow(
      /already in use/iu,
    );

    expect(containers.remove).not.toHaveBeenCalled();
    expect(getFleetCell(env, "acme")).toBeDefined();
  });
});
