import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { resolvePersistCandidateForWrite } from "../../config/io.write-prepare.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type * as ConfigWriteFlowModule from "./config-write-flow.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";
import { expectRpcError, expectRpcResult } from "./rpc-response.test-support.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), commit: vi.fn() }));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: mocks.read,
}));
vi.mock("../../config/runtime-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-schema.js")>()),
  loadGatewayConfigRedactionHints: () => ({}),
}));
vi.mock("../../secrets/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/runtime.js")>()),
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
    params: { raw: JSON.stringify(raw), baseHash: "base-hash", ...options },
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
        keep: {},
        first: { skills: [] },
        second: { tools: { deny: ["*"] } },
      },
    },
  };
  persisted = undefined;
  mocks.read.mockImplementation(async () => createConfigWriteSnapshot(current));
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

it("removes only explicitly deleted existing entries in a revision-checked batch", async () => {
  const respond = await invoke(
    { agents: { entries: { first: null, second: null, unknown: null } } },
    { replacePaths },
  );
  expectRpcResult(respond, expect.anything());
  expect(mocks.commit).toHaveBeenCalledWith(
    expect.objectContaining({
      writeOptions: expect.objectContaining({ allowedAgentRosterRemovals: ["first", "second"] }),
    }),
  );
  expect(persisted).toEqual({
    agents: { ...current.agents, entries: { keep: {} } },
  });
  expect(Object.keys(current.agents!.entries!)).toEqual(["keep", "first", "second"]);
});

it.each([
  ["missing revision", undefined, replacePaths, { first: null }, undefined],
  ["stale revision", "stale-hash", replacePaths, { first: null }, undefined],
  ["unacknowledged arrays", "base-hash", undefined, { first: null }, "replacePaths"],
  ["deleted roster", "base-hash", replacePaths, null, undefined],
] as const)("rejects %s before committing", async (_name, baseHash, paths, entries, message) => {
  const respond = await invoke({ agents: { entries } }, { baseHash, replacePaths: paths });
  expectRpcError(respond, {
    code: "INVALID_REQUEST",
    ...(message ? { message: expect.stringContaining(message) } : {}),
  });
  expect(mocks.commit).not.toHaveBeenCalled();
});

it("does not authorize omitted siblings during ordinary entry updates", async () => {
  const respond = await invoke({ agents: { entries: { keep: { name: "Renamed" } } } });
  expectRpcResult(respond, expect.anything());
  expect(persisted).toEqual({
    agents: {
      ...current.agents,
      entries: { ...current.agents!.entries, keep: { name: "Renamed" } },
    },
  });
});
