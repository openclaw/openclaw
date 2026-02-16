import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "./prompts.js";

// Mock the Docker module
const mockCheckDockerEnvironment = vi.hoisted(() => vi.fn());
const mockDetectExistingMongoDB = vi.hoisted(() => vi.fn());
const mockAutoStartMongoDB = vi.hoisted(() => vi.fn());
const mockGetComposeFilePath = vi.hoisted(() => vi.fn());
const mockGetRunningClawMongoContainers = vi.hoisted(() => vi.fn());
const mockIsPortInUse = vi.hoisted(() => vi.fn());

vi.mock("../docker/mongodb-docker.js", () => ({
  checkDockerEnvironment: mockCheckDockerEnvironment,
  detectExistingMongoDB: mockDetectExistingMongoDB,
  autoStartMongoDB: mockAutoStartMongoDB,
  getComposeFilePath: mockGetComposeFilePath,
  getRunningClawMongoContainers: mockGetRunningClawMongoContainers,
  isPortInUse: mockIsPortInUse,
}));

function createMockPrompter(responses?: {
  selectResponses?: unknown[];
  textResponses?: string[];
  confirmResponses?: boolean[];
}): WizardPrompter {
  const selectResponses = [...(responses?.selectResponses ?? [])];
  const textResponses = [...(responses?.textResponses ?? [])];
  const confirmResponses = [...(responses?.confirmResponses ?? [true])];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => selectResponses.shift()),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => textResponses.shift() ?? ""),
    confirm: vi.fn(async () => confirmResponses.shift() ?? true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("attemptAutoSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComposeFilePath.mockReturnValue("/path/to/compose.yml");
    mockIsPortInUse.mockResolvedValue(false);
  });

  it("reuses existing MongoDB when found", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({
      connected: true,
      uri: "mongodb://localhost:27017/openclaw",
      isDocker: true,
    });
    const prompter = createMockPrompter({ confirmResponses: [true] });
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(true);
    expect(result.uri).toBe("mongodb://localhost:27017/openclaw");
    expect(result.source).toBe("existing");
  });

  it("reuses non-Docker existing MongoDB", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({
      connected: true,
      uri: "mongodb://localhost:27017/openclaw",
      isDocker: false,
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(true);
    expect(result.source).toBe("existing");
    // Should show note about found MongoDB
    expect(prompter.note).toHaveBeenCalled();
  });

  it("auto-starts Docker MongoDB when no existing found and Docker available", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: "v2",
    });
    mockGetRunningClawMongoContainers.mockResolvedValue({ running: false, containers: [] });
    mockAutoStartMongoDB.mockResolvedValue({
      success: true,
      tier: "fullstack",
      uri: "mongodb://admin:admin@localhost:27017/?authSource=admin&replicaSet=rs0",
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(true);
    expect(result.uri).toContain("localhost:27017");
    expect(result.source).toBe("docker-auto");
    expect(result.tier).toBe("fullstack");
  });

  it("reconnects to existing ClawMongo containers", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    // First detectExistingMongoDB returns false
    mockDetectExistingMongoDB
      .mockResolvedValueOnce({ connected: false })
      // Second call (after finding running containers) returns true
      .mockResolvedValueOnce({
        connected: true,
        uri: "mongodb://localhost:27017/openclaw",
        isDocker: true,
      });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: "v2",
    });
    mockGetRunningClawMongoContainers.mockResolvedValue({
      running: true,
      tier: "replicaset",
      containers: ["clawmongo-mongod"],
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(true);
    expect(result.source).toBe("docker-existing");
    expect(result.tier).toBe("replicaset");
  });

  it("falls back to manual when Docker is not installed", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: false,
      daemonRunning: false,
      composeAvailable: false,
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Docker");
  });

  it("falls back to manual when Docker daemon is not running", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: false,
      composeAvailable: false,
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Docker");
  });

  it("falls back to manual when Docker Compose is not available", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: false,
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Compose");
  });

  it("falls back to manual when all Docker tiers fail", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: "v2",
    });
    mockGetRunningClawMongoContainers.mockResolvedValue({ running: false, containers: [] });
    mockAutoStartMongoDB.mockResolvedValue({ success: false, error: "all tiers failed" });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(false);
  });

  it("detects port conflict and shows helpful message", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    // Port in use but NOT MongoDB
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockIsPortInUse.mockResolvedValue(true);
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: "v2",
    });
    mockGetRunningClawMongoContainers.mockResolvedValue({ running: false, containers: [] });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    // Should note port conflict to user
    expect(prompter.note).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Port");
  });

  it("shows tier labels in success note", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: "v2",
    });
    mockGetRunningClawMongoContainers.mockResolvedValue({ running: false, containers: [] });
    mockAutoStartMongoDB.mockResolvedValue({
      success: true,
      tier: "standalone",
      uri: "mongodb://localhost:27017/openclaw",
    });
    const prompter = createMockPrompter();
    await attemptAutoSetup(prompter);
    // Should show note with tier description
    const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const startedNote = noteCalls.find(
      (c: unknown[]) => typeof c[1] === "string" && c[1] === "MongoDB Started",
    );
    expect(startedNote).toBeDefined();
    expect(startedNote![0]).toContain("basic features");
  });
});
