import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigIoModule from "../../config/io.js";
import { resolvePersistCandidateForWrite } from "../../config/io.write-prepare.js";
import type * as RuntimeSchemaModule from "../../config/runtime-schema.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type * as SecretsRuntimeModule from "../../secrets/runtime.js";
import type * as ConfigWriteFlowModule from "./config-write-flow.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), commit: vi.fn() }));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigIoModule>()),
  readConfigFileSnapshotForWrite: mocks.read,
}));
vi.mock("../../config/runtime-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeSchemaModule>()),
  loadGatewayConfigRedactionHints: () => ({}),
}));
vi.mock("../../secrets/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SecretsRuntimeModule>()),
  prepareSecretsRuntimeSnapshot: async ({ config }: { config: OpenClawConfig }) => ({ config }),
}));
vi.mock("./config-write-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigWriteFlowModule>()),
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
      ownership: "explicit",
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
    async (params: Parameters<typeof ConfigWriteFlowModule.commitGatewayConfigWrite>[0]) => {
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
    expect(persisted).toEqual({
      agents: { ...current.agents, entries: { keep: { name: "Untouched" } } },
    });
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
    expect(persisted).toEqual({
      agents: {
        ...current.agents,
        entries: { ...current.agents!.entries, keep: { name: "Renamed" } },
      },
    });
  });

  it("rejects deleting the keyed roster container before committing", async () => {
    const respond = await invoke(
      { agents: { entries: null } },
      { baseHash: "base-hash", replacePaths },
    );
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(persisted).toBeUndefined();
  });
});
