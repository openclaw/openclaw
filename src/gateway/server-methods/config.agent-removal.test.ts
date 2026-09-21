import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePersistCandidateForWrite } from "../../config/io.write-prepare.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), commit: vi.fn() }));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: mocks.read,
}));
vi.mock("../../config/validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/validation.js")>()),
  validateConfigObjectRawWithPlugins: (config: OpenClawConfig) => ({
    ok: true,
    config,
    warnings: [],
  }),
  validateConfigObjectWithPlugins: (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
}));
vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ schema: { type: "object" }, version: "test-schema" }),
}));
vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: async ({ config }: { config: OpenClawConfig }) => ({ config }),
}));
vi.mock("./config-write-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-write-flow.js")>()),
  commitGatewayConfigWrite: mocks.commit,
  resolveGatewayConfigRestartWriteResult: async () => ({
    payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
    sentinelPersisted: false,
    restart: undefined,
  }),
}));

let current: OpenClawConfig;
let persisted: unknown;
const replacePaths = ["agents.entries.first.skills", "agents.entries.second.tools.deny"];

async function invoke(raw: unknown, options: { baseHash?: string; replacePaths?: string[] } = {}) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: { raw: JSON.stringify(raw), ...options },
  });
  await expectDefined(configHandlers["config.patch"], "config.patch handler")(harness.options);
  return harness.respond;
}

beforeEach(() => {
  vi.clearAllMocks();
  current = {
    agents: {
      entries: {
        keep: { name: "Untouched" },
        first: { name: "First", skills: [] },
        second: { name: "Second", tools: { deny: ["*"] } },
      },
    },
  };
  persisted = undefined;
  mocks.read.mockImplementation(async () => createConfigWriteSnapshot(current));
  // Keep handler isolation, but exercise the real persistence roster guard rather
  // than accepting any nextConfig that reaches the mocked commit boundary.
  mocks.commit.mockImplementation(
    async (
      params: Parameters<typeof import("./config-write-flow.js").commitGatewayConfigWrite>[0],
    ) => {
      persisted = resolvePersistCandidateForWrite({
        inputBasis: { kind: "source", config: params.snapshot.sourceConfig },
        runtimeConfig: params.snapshot.config,
        sourceConfig: params.snapshot.sourceConfig,
        nextConfig: params.nextConfig,
        allowedAgentRosterRemovals: params.writeOptions.allowedAgentRosterRemovals,
      });
      return {
        path: params.snapshot.path,
        config: params.nextConfig,
        hash: "next-hash",
        queueFollowUp: vi.fn(),
      };
    },
  );
});

describe("config.patch explicit agent removal", () => {
  it("removes only explicitly deleted existing entries in a revision-checked batch", async () => {
    const respond = await invoke(
      { agents: { entries: { first: null, second: null, unknown: null } } },
      { baseHash: "base-hash", replacePaths },
    );
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: expect.objectContaining({ allowedAgentRosterRemovals: ["first", "second"] }),
      }),
    );
    expect(persisted).toEqual({ agents: { entries: { keep: { name: "Untouched" } } } });
    expect(Object.keys(current.agents!.entries!)).toEqual(["keep", "first", "second"]);
  });

  it.each([undefined, "stale-hash"])(
    "rejects removal with baseHash %s before committing",
    async (baseHash) => {
      const respond = await invoke(
        { agents: { entries: { first: null } } },
        { baseHash, replacePaths },
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(mocks.commit).not.toHaveBeenCalled();
      expect(persisted).toBeUndefined();
    },
  );

  it("still requires acknowledgment of arrays inside a removed entry", async () => {
    const respond = await invoke(
      { agents: { entries: { first: null } } },
      { baseHash: "base-hash" },
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("replacePaths"),
      }),
    );
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not authorize omitted siblings during ordinary entry updates", async () => {
    const respond = await invoke(
      { agents: { entries: { keep: { name: "Renamed" } } } },
      { baseHash: "base-hash" },
    );
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: expect.objectContaining({ allowedAgentRosterRemovals: [] }),
      }),
    );
    expect(persisted).toEqual({
      agents: { entries: { ...current.agents!.entries, keep: { name: "Renamed" } } },
    });
  });

  it.each([{ agents: null }, { agents: { entries: null } }])(
    "does not authorize dropping a parent container: %j",
    async (raw) => {
      await invoke(raw, { baseHash: "base-hash", replacePaths });
      expect(mocks.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({ allowedAgentRosterRemovals: [] }),
        }),
      );
    },
  );
});
