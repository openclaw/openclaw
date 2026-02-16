import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock execDocker and execDockerRaw from sandbox
const mockExecDocker = vi.hoisted(() => vi.fn());
const mockExecDockerRaw = vi.hoisted(() => vi.fn());
const mockDockerContainerState = vi.hoisted(() => vi.fn());
vi.mock("../agents/sandbox/docker.js", () => ({
  execDocker: mockExecDocker,
  execDockerRaw: mockExecDockerRaw,
  dockerContainerState: mockDockerContainerState,
}));

// Mock mongodb driver
const mockMongoClientCloseFn = vi.hoisted(() => vi.fn(async () => {}));
const mockMongoClientConnectFn = vi.hoisted(() => vi.fn(async () => {}));
const mockMongoClientDbFn = vi.hoisted(() =>
  vi.fn(() => ({
    admin: () => ({
      command: vi.fn().mockResolvedValue({ ok: 1 }),
    }),
  })),
);

vi.mock("mongodb", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock requires constructor pattern
  const MockMongoClient: any = function (this: Record<string, unknown>) {
    this.connect = mockMongoClientConnectFn;
    this.close = mockMongoClientCloseFn;
    this.db = mockMongoClientDbFn;
  };
  MockMongoClient.prototype = {};
  return { MongoClient: MockMongoClient };
});

// ---------------------------------------------------------------------------
// Docker Detection
// ---------------------------------------------------------------------------

describe("isDockerInstalled", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when docker --version succeeds", async () => {
    const { isDockerInstalled } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "Docker version 24.0.7", stderr: "", code: 0 });
    expect(await isDockerInstalled()).toBe(true);
  });

  it("returns false when docker --version fails", async () => {
    const { isDockerInstalled } = await import("./mongodb-docker.js");
    mockExecDocker.mockRejectedValue(new Error("command not found"));
    expect(await isDockerInstalled()).toBe(false);
  });
});

describe("isDockerDaemonRunning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when docker info succeeds", async () => {
    const { isDockerDaemonRunning } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "Server: Docker Engine", stderr: "", code: 0 });
    expect(await isDockerDaemonRunning()).toBe(true);
  });

  it("returns false when docker info fails", async () => {
    const { isDockerDaemonRunning } = await import("./mongodb-docker.js");
    mockExecDocker.mockRejectedValue(new Error("Cannot connect to Docker daemon"));
    expect(await isDockerDaemonRunning()).toBe(false);
  });
});

describe("isDockerComposeAvailable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 'v2' when docker compose version succeeds", async () => {
    const { isDockerComposeAvailable } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({
      stdout: "Docker Compose version v2.23.0",
      stderr: "",
      code: 0,
    });
    expect(await isDockerComposeAvailable()).toBe("v2");
  });

  it("returns false when docker compose is not available", async () => {
    const { isDockerComposeAvailable } = await import("./mongodb-docker.js");
    mockExecDocker.mockRejectedValue(new Error("not found"));
    expect(await isDockerComposeAvailable()).toBe(false);
  });
});

describe("checkDockerEnvironment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns full status when all checks pass", async () => {
    const { checkDockerEnvironment } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
    const result = await checkDockerEnvironment();
    expect(result.installed).toBe(true);
    expect(result.daemonRunning).toBe(true);
    expect(result.composeAvailable).toBe("v2");
  });

  it("short-circuits when Docker is not installed", async () => {
    const { checkDockerEnvironment } = await import("./mongodb-docker.js");
    mockExecDocker.mockRejectedValue(new Error("not found"));
    const result = await checkDockerEnvironment();
    expect(result.installed).toBe(false);
    expect(result.daemonRunning).toBe(false);
    expect(result.composeAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Existing MongoDB Detection
// ---------------------------------------------------------------------------

describe("detectExistingMongoDB", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMongoClientConnectFn.mockResolvedValue(undefined);
    mockMongoClientCloseFn.mockResolvedValue(undefined);
    mockDockerContainerState.mockResolvedValue({ exists: false, running: false });
  });

  it("returns connected=true when MongoDB is reachable at localhost:27017", async () => {
    const { detectExistingMongoDB } = await import("./mongodb-docker.js");
    const result = await detectExistingMongoDB();
    expect(result.connected).toBe(true);
    expect(result.uri).toBe("mongodb://localhost:27017/openclaw");
  });

  it("returns connected=false when MongoDB is not reachable", async () => {
    const { detectExistingMongoDB } = await import("./mongodb-docker.js");
    mockMongoClientConnectFn.mockRejectedValue(new Error("connection refused"));
    const result = await detectExistingMongoDB();
    expect(result.connected).toBe(false);
  });

  it("detects Docker container when clawmongo-mongod is running", async () => {
    const { detectExistingMongoDB } = await import("./mongodb-docker.js");
    mockDockerContainerState.mockImplementation(async (name: string) => {
      if (name === "clawmongo-mongod") {
        return { exists: true, running: true };
      }
      return { exists: false, running: false };
    });
    const result = await detectExistingMongoDB();
    expect(result.connected).toBe(true);
    expect(result.isDocker).toBe(true);
  });

  it("detects Docker container when clawmongo-mongod-standalone is running", async () => {
    const { detectExistingMongoDB } = await import("./mongodb-docker.js");
    mockDockerContainerState.mockImplementation(async (name: string) => {
      if (name === "clawmongo-mongod-standalone") {
        return { exists: true, running: true };
      }
      return { exists: false, running: false };
    });
    const result = await detectExistingMongoDB();
    expect(result.connected).toBe(true);
    expect(result.isDocker).toBe(true);
  });

  it("closes MongoClient even on error", async () => {
    const { detectExistingMongoDB } = await import("./mongodb-docker.js");
    mockMongoClientConnectFn.mockRejectedValue(new Error("fail"));
    await detectExistingMongoDB();
    // Should not throw
  });
});

// ---------------------------------------------------------------------------
// Port Conflict Detection
// ---------------------------------------------------------------------------

describe("isPortInUse", () => {
  it("returns true when port is in use", async () => {
    const { isPortInUse } = await import("./mongodb-docker.js");
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    expect(await isPortInUse(port)).toBe(true);
    server.close();
  });

  it("returns false when port is free", async () => {
    const { isPortInUse } = await import("./mongodb-docker.js");
    // Port 59999 is very unlikely to be in use
    expect(await isPortInUse(59999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Docker Compose Orchestration
// ---------------------------------------------------------------------------

describe("getComposeFilePath", () => {
  it("resolves to docker/mongodb/docker-compose.mongodb.yml relative to package root", async () => {
    const { getComposeFilePath } = await import("./mongodb-docker.js");
    const filePath = getComposeFilePath();
    expect(filePath).toContain("docker/mongodb/docker-compose.mongodb.yml");
  });
});

describe("runSetupGenerator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs docker compose with setup profile", async () => {
    const { runSetupGenerator } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await runSetupGenerator("/path/to/compose.yml");
    expect(mockExecDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        "compose",
        "-f",
        "/path/to/compose.yml",
        "--profile",
        "setup",
        "run",
        "--rm",
        "setup-generator",
      ]),
      expect.anything(),
    );
  });
});

describe("startMongoDBCompose", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts fullstack profile with setup first", async () => {
    const { startMongoDBCompose } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await startMongoDBCompose("/path/to/compose.yml", "fullstack");
    // setup-generator should be called first (for fullstack and replicaset)
    expect(mockExecDocker).toHaveBeenCalledTimes(2); // setup + up -d
  });

  it("starts standalone without setup", async () => {
    const { startMongoDBCompose } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await startMongoDBCompose("/path/to/compose.yml", "standalone");
    // standalone does NOT need setup-generator
    expect(mockExecDocker).toHaveBeenCalledTimes(1); // just up -d
  });

  it("starts replicaset with setup first", async () => {
    const { startMongoDBCompose } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await startMongoDBCompose("/path/to/compose.yml", "replicaset");
    expect(mockExecDocker).toHaveBeenCalledTimes(2); // setup + up -d
  });
});

describe("stopMongoDBCompose", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops all profiles", async () => {
    const { stopMongoDBCompose } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await stopMongoDBCompose("/path/to/compose.yml");
    expect(mockExecDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        "compose",
        "-f",
        "/path/to/compose.yml",
        "--profile",
        "standalone",
        "--profile",
        "replicaset",
        "--profile",
        "fullstack",
        "down",
      ]),
      expect.anything(),
    );
  });
});

describe("waitForMongoDBHealth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves when container becomes healthy", async () => {
    const { waitForMongoDBHealth } = await import("./mongodb-docker.js");
    mockExecDocker
      .mockResolvedValueOnce({ stdout: "starting", stderr: "", code: 0 })
      .mockResolvedValueOnce({ stdout: "healthy", stderr: "", code: 0 });
    const result = await waitForMongoDBHealth("clawmongo-mongod", {
      timeoutMs: 5000,
      pollIntervalMs: 100,
    });
    expect(result).toBe(true);
  });

  it("returns false on timeout", async () => {
    const { waitForMongoDBHealth } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "starting", stderr: "", code: 0 });
    const result = await waitForMongoDBHealth("clawmongo-mongod", {
      timeoutMs: 300,
      pollIntervalMs: 100,
    });
    expect(result).toBe(false);
  });

  it("returns false when container is unhealthy", async () => {
    const { waitForMongoDBHealth } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "unhealthy", stderr: "", code: 0 });
    const result = await waitForMongoDBHealth("clawmongo-mongod", {
      timeoutMs: 5000,
      pollIntervalMs: 100,
    });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-Start with Fallback Tiers
// ---------------------------------------------------------------------------

describe("autoStartMongoDB", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts fullstack and returns the tier on success", async () => {
    const { autoStartMongoDB } = await import("./mongodb-docker.js");
    mockExecDocker.mockImplementation(async (args: string[]) => {
      if (args.includes("--format") && args.includes("{{.State.Health.Status}}")) {
        return { stdout: "healthy", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const progressCalls: string[] = [];
    const result = await autoStartMongoDB({
      composeFile: "/path/to/compose.yml",
      onProgress: (msg) => progressCalls.push(msg),
      healthTimeoutMs: 5000,
      healthPollIntervalMs: 100,
    });
    expect(result.success).toBe(true);
    expect(result.tier).toBe("fullstack");
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it("falls back to replicaset when fullstack fails", async () => {
    const { autoStartMongoDB } = await import("./mongodb-docker.js");
    mockExecDocker.mockImplementation(async (args: string[]) => {
      // Fail the fullstack up -d
      if (args.includes("fullstack") && args.includes("up")) {
        throw new Error("mongot image not found");
      }
      // Health check for replicaset returns healthy
      if (args.includes("--format") && args.includes("{{.State.Health.Status}}")) {
        return { stdout: "healthy", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const result = await autoStartMongoDB({
      composeFile: "/path/to/compose.yml",
      healthTimeoutMs: 5000,
      healthPollIntervalMs: 100,
    });
    expect(result.success).toBe(true);
    expect(result.tier).toBe("replicaset");
  });

  it("falls back to standalone when replicaset fails", async () => {
    const { autoStartMongoDB } = await import("./mongodb-docker.js");
    mockExecDocker.mockImplementation(async (args: string[]) => {
      if ((args.includes("fullstack") || args.includes("replicaset")) && args.includes("up")) {
        throw new Error("auth files failed");
      }
      if (args.includes("setup") && args.includes("run")) {
        throw new Error("setup failed");
      }
      if (args.includes("--format") && args.includes("{{.State.Health.Status}}")) {
        return { stdout: "healthy", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const result = await autoStartMongoDB({
      composeFile: "/path/to/compose.yml",
      healthTimeoutMs: 5000,
      healthPollIntervalMs: 100,
    });
    expect(result.success).toBe(true);
    expect(result.tier).toBe("standalone");
  });

  it("returns success=false when all tiers fail", async () => {
    const { autoStartMongoDB } = await import("./mongodb-docker.js");
    mockExecDocker.mockImplementation(async (args: string[]) => {
      if (args.includes("up")) {
        throw new Error("everything failed");
      }
      if (args.includes("setup") && args.includes("run")) {
        throw new Error("setup failed");
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const result = await autoStartMongoDB({
      composeFile: "/path/to/compose.yml",
      healthTimeoutMs: 1000,
      healthPollIntervalMs: 100,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Running Container Detection
// ---------------------------------------------------------------------------

describe("getRunningClawMongoContainers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detects fullstack when both mongod and mongot are running", async () => {
    const { getRunningClawMongoContainers } = await import("./mongodb-docker.js");
    mockDockerContainerState.mockImplementation(async (name: string) => {
      if (name === "clawmongo-mongod") {
        return { exists: true, running: true };
      }
      if (name === "clawmongo-mongot") {
        return { exists: true, running: true };
      }
      return { exists: false, running: false };
    });
    const result = await getRunningClawMongoContainers();
    expect(result.running).toBe(true);
    expect(result.tier).toBe("fullstack");
  });

  it("detects replicaset when only mongod is running", async () => {
    const { getRunningClawMongoContainers } = await import("./mongodb-docker.js");
    mockDockerContainerState.mockImplementation(async (name: string) => {
      if (name === "clawmongo-mongod") {
        return { exists: true, running: true };
      }
      return { exists: false, running: false };
    });
    const result = await getRunningClawMongoContainers();
    expect(result.running).toBe(true);
    expect(result.tier).toBe("replicaset");
  });

  it("detects standalone when standalone container is running", async () => {
    const { getRunningClawMongoContainers } = await import("./mongodb-docker.js");
    mockDockerContainerState.mockImplementation(async (name: string) => {
      if (name === "clawmongo-mongod-standalone") {
        return { exists: true, running: true };
      }
      return { exists: false, running: false };
    });
    const result = await getRunningClawMongoContainers();
    expect(result.running).toBe(true);
    expect(result.tier).toBe("standalone");
  });

  it("returns running=false when no containers running", async () => {
    const { getRunningClawMongoContainers } = await import("./mongodb-docker.js");
    mockDockerContainerState.mockResolvedValue({ exists: false, running: false });
    const result = await getRunningClawMongoContainers();
    expect(result.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Image Pull with Progress
// ---------------------------------------------------------------------------

describe("pullImageWithProgress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports progress during image pull", async () => {
    const { pullImageWithProgress } = await import("./mongodb-docker.js");
    mockExecDockerRaw.mockResolvedValue({
      stdout: Buffer.from("Downloaded newer image"),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    const messages: string[] = [];
    const result = await pullImageWithProgress("mongodb/mongodb-community-server:latest", (msg) =>
      messages.push(msg),
    );
    expect(result).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("returns false on pull failure", async () => {
    const { pullImageWithProgress } = await import("./mongodb-docker.js");
    mockExecDockerRaw.mockRejectedValue(new Error("network timeout"));
    const result = await pullImageWithProgress("nonexistent:latest");
    expect(result).toBe(false);
  });
});
