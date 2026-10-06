import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => ({
  acquireGatewayLock: vi.fn(),
  callGateway: vi.fn(),
  config: {} as { gateway?: { mode: "local" | "remote" } },
  getSkillCuratorStatus: vi.fn(),
  releaseGatewayLock: vi.fn(),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  },
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isGatewayClientRequestError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayClientRequestError",
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
  isImplicitLocalGatewayTarget: async ({ config }: { config?: { gateway?: { mode?: string } } }) =>
    !process.env.OPENCLAW_GATEWAY_URL && config?.gateway?.mode !== "remote",
}));
vi.mock("../infra/gateway-lock.js", () => ({ acquireGatewayLock: mocks.acquireGatewayLock }));
vi.mock("../skills/workshop/curator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/workshop/curator.js")>()),
  getSkillCuratorStatus: mocks.getSkillCuratorStatus,
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
  resetConfigRuntimeState: () => undefined,
}));
const skill = {
  skillFile: "/workspace/skills/daily-brief/SKILL.md",
  skillKey: "daily-brief",
  skillName: "Daily Brief",
  state: "active",
  pinned: false,
  createdAtMs: 1,
  stateChangedAtMs: 1,
  lastUsedAtMs: null,
  useCount: 0,
  archivedReason: null,
};
const status = {
  lastAttemptAtMs: 1,
  lastSuccessAtMs: 1,
  lastError: null,
  collectionReview: { workspace1: { attemptedAtMs: 1, succeededAtMs: 2 } },
  experienceReview: {
    workspace1: { attemptedAtMs: 3, outcome: "proposed" as const, proposalId: "proposal-1" },
  },
  counts: { active: 1, stale: 0, archived: 0 },
  skills: [skill],
  overlaps: [],
};
const actions = [
  ["status"],
  ["pin", "daily-brief"],
  ["unpin", "daily-brief"],
  ["restore", "daily-brief"],
];
function run(...args: string[]) {
  const program = new Command().enablePositionalOptions().exitOverride();
  registerSkillsCli(program);
  return program.parseAsync(["skills", "curator", ...args], { from: "user" });
}
function unavailable() {
  return new GatewayTransportError({
    kind: "closed",
    code: 1006,
    reason: "unavailable",
    message: "gateway closed (1006): unavailable",
    connectionDetails: { url: "ws://127.0.0.1:18789", urlSource: "local loopback", message: "" },
  });
}
function credentialsError() {
  return Object.assign(new Error("gateway requires credentials"), {
    name: "GatewayCredentialsRequiredError",
    method: "skills.curator.pin",
    configPath: "/tmp/openclaw.json",
  });
}

describe("skills curator CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete mocks.config.gateway;
    mocks.getSkillCuratorStatus.mockReset().mockReturnValue(status);
    mocks.acquireGatewayLock.mockReset().mockResolvedValue({
      run: <T>(action: () => T) => action(),
      release: mocks.releaseGatewayLock,
    });
    mocks.callGateway.mockReset().mockResolvedValue(status);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses --json for the default curator action", async () => {
    await run("--json");
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(status);
  });

  it("renders legacy inventory and disambiguates repeated keys without local fallback", async () => {
    mocks.config.gateway = { mode: "remote" };
    mocks.callGateway.mockResolvedValue({
      ...status,
      skills: [skill, { ...skill, skillFile: "/other/SKILL.md" }],
    });
    await run("status");
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "skills.curator.status",
        params: {},
        caps: [GATEWAY_CLIENT_CAPS.SKILL_CURATOR_LIVE_INVENTORY],
      }),
    );
    expect(mocks.getSkillCuratorStatus).not.toHaveBeenCalled();
    const output = mocks.defaultRuntime.writeStdout.mock.calls[0]?.[0];
    expect(output).toContain("Legacy inventory:");
    expect(output).toContain("daily-brief (/workspace/skills/daily-brief/SKILL.md)  active");
    expect(output).toContain("daily-brief (/other/SKILL.md)  active");
    expect(output).toContain("last-used=not recorded");
    expect(output).toContain("Collection review: attempted");
    expect(output).toContain("Experience review workspac: proposed (proposal-1)");
  });

  it("preserves live inventory and awaits asynchronous local status before output", async () => {
    const liveStatus = {
      ...status,
      inventory: "live-workshop",
      skills: [{ ...skill, createdAtMs: null, stateChangedAtMs: null }],
    };
    mocks.callGateway.mockResolvedValue(liveStatus);
    await run("status");
    expect(mocks.defaultRuntime.writeStdout).not.toHaveBeenCalledWith(
      expect.stringContaining("Legacy inventory:"),
    );
    mocks.callGateway.mockRejectedValue(unavailable());
    const requested = createDeferred();
    const pendingStatus = createDeferred<typeof liveStatus>();
    mocks.getSkillCuratorStatus.mockImplementationOnce(() => {
      requested.resolve();
      return pendingStatus.promise;
    });
    mocks.defaultRuntime.writeStdout.mockClear();
    const command = run("--json", "status");
    try {
      await requested.promise;
      expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.writeStdout).not.toHaveBeenCalled();
    } finally {
      pendingStatus.resolve(liveStatus);
      await command;
    }
    expect(mocks.getSkillCuratorStatus).toHaveBeenCalledWith({ config: mocks.config });
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(liveStatus);
  });

  it("reports retirement for registered curator mutations", async () => {
    for (const action of actions.slice(1)) {
      await expect(run(...action, "--json")).rejects.toThrow("__exit__:1");
    }
    expect(mocks.callGateway.mock.calls.map(([request]) => request.method)).toEqual([
      "skills.curator.pin",
      "skills.curator.unpin",
      "skills.curator.restore",
    ]);
    expect(mocks.defaultRuntime.error).toHaveBeenCalledTimes(3);
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Skill lifecycle curation is retired"),
    );
    expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("never falls back to client-local state for an explicit remote Gateway", async () => {
    mocks.config.gateway = { mode: "remote" };
    const error = unavailable();
    mocks.callGateway.mockRejectedValue(error);
    for (const action of actions) {
      await expect(run(...action, "--json")).rejects.toBe(error);
    }
    expect(mocks.getSkillCuratorStatus).not.toHaveBeenCalled();
    expect(mocks.acquireGatewayLock).not.toHaveBeenCalled();
  });

  it("requires and releases the offline ownership lock for retired mutations", async () => {
    mocks.callGateway.mockRejectedValue(credentialsError());
    await run("status", "--json");
    for (const action of actions.slice(1)) {
      await expect(run(...action, "--json")).rejects.toThrow("__exit__:1");
    }
    expect(mocks.getSkillCuratorStatus).toHaveBeenCalledOnce();
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Skill lifecycle curation is retired"),
    );
    expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(3);
    expect(mocks.acquireGatewayLock).toHaveBeenCalledWith({
      allowInTests: true,
      port: 18789,
      role: "sqlite-maintenance",
      timeoutMs: 250,
    });
    expect(mocks.releaseGatewayLock).toHaveBeenCalledTimes(3);
  });

  it("preserves credential failure when the Gateway still owns the lock", async () => {
    const error = credentialsError();
    mocks.callGateway.mockRejectedValue(error);
    mocks.acquireGatewayLock.mockRejectedValue(new Error("gateway already running"));
    await expect(run("pin", "daily-brief", "--json")).rejects.toBe(error);
    expect(mocks.acquireGatewayLock).toHaveBeenCalledOnce();
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("permits legacy-method fallback only for status", async () => {
    mocks.callGateway.mockImplementation(async ({ method }: { method: string }) => {
      throw new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: `unknown method: ${method}`,
      });
    });
    await run("status", "--json");
    await expect(run("pin", "daily-brief", "--json")).rejects.toThrow("__exit__:1");
    expect(mocks.defaultRuntime.error).toHaveBeenLastCalledWith(
      "unknown method: skills.curator.pin",
    );
    expect(mocks.getSkillCuratorStatus).toHaveBeenCalledOnce();
    expect(mocks.acquireGatewayLock).not.toHaveBeenCalled();
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
  });
});
