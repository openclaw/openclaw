import { afterEach, expect, it, vi } from "vitest";

const prepared = vi.hoisted(() => ({
  load: vi.fn(),
  acquire: vi.fn(),
}));
// Model-runtime publication is Gateway-owned; this suite checks only how a Talk
// consult borrows it for the session's own model and releases both leases.
// mock-isolation: Gateway owns model-runtime publication; this suite checks only Talk's lease borrowing.
vi.mock("../../agents/prepared-model-runtime.js", () => ({
  loadPublishedGatewayReplyDispatchRuntime: prepared.load,
  acquireAgentRunPreparedModelRuntime: prepared.acquire,
}));

import { getPreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime-generation-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTalkConsultPublishedRuntime } from "./client-agent-runtime-dispatch.js";

afterEach(() => {
  prepared.load.mockReset();
  prepared.acquire.mockReset();
});

function lease(name: string) {
  const pluginGeneration = { name } as never;
  return {
    snapshot: { name } as never,
    pluginGeneration,
    run: <T>(run: () => T) => run(),
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
  };
}

const config: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-5-5" },
      models: { "anthropic/claude-sonnet-5-5": { agentRuntime: { id: "claude-cli" } } },
    },
  },
};

const target = { agentId: "main", sessionKey: "agent:main:main", sessionEntry: undefined };

function publishRuntime(runtimeConfig: OpenClawConfig = config) {
  const dispatch = lease("dispatch");
  prepared.load.mockImplementation(async (params: { onRuntimeLease: (l: unknown) => void }) => {
    params.onRuntimeLease(dispatch);
    return {
      agentId: "main",
      agentDir: "/a",
      workspaceDir: "/w",
      config: runtimeConfig,
      pluginGeneration: dispatch.pluginGeneration,
    };
  });
  return dispatch;
}

it("runs the consult in the published runtime leased for the session's own model", async () => {
  const dispatchLease = publishRuntime();
  const modelLease = lease("model");
  prepared.acquire.mockResolvedValue(modelLease);
  const run = vi.fn(async (context: unknown) => {
    expect(getPreparedModelRuntimePluginGeneration()).toBe(modelLease.pluginGeneration);
    expect(dispatchLease[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(modelLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
    return context;
  });
  const context = await withTalkConsultPublishedRuntime(
    {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionEntry: { sessionId: "s", updatedAt: 1 },
      workspaceDir: "/session-worktree",
    },
    run,
  );
  expect(context).toEqual({ config, pluginGeneration: modelLease.pluginGeneration });
  expect(prepared.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "main",
      workspaceDir: "/session-worktree",
      runtimePluginSelections: [
        expect.objectContaining({ provider: "anthropic", modelId: "claude-sonnet-5-5" }),
      ],
    }),
    expect.objectContaining({ pluginGeneration: dispatchLease.pluginGeneration }),
  );
  expect(modelLease[Symbol.asyncDispose]).toHaveBeenCalledOnce();
});

it("releases the dispatch lease without starting a consult when no model is configured", async () => {
  const dispatchLease = publishRuntime({});
  const run = vi.fn();
  await expect(withTalkConsultPublishedRuntime(target, run)).rejects.toThrow(
    "No model is configured",
  );
  expect(dispatchLease[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  expect(prepared.acquire).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("keeps the command owner's own loading when no runtime is published", async () => {
  prepared.load.mockResolvedValue(undefined);
  const run = vi.fn(async (context: unknown) => context);
  await expect(withTalkConsultPublishedRuntime(target, run)).resolves.toBeUndefined();
  expect(prepared.acquire).not.toHaveBeenCalled();
});

it("releases the model lease when the consult fails", async () => {
  const dispatchLease = publishRuntime();
  const modelLease = lease("model");
  prepared.acquire.mockResolvedValue(modelLease);
  await expect(
    withTalkConsultPublishedRuntime(target, async () => {
      throw new Error("synthetic consult failure");
    }),
  ).rejects.toThrow("synthetic consult failure");
  expect(dispatchLease[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  expect(modelLease[Symbol.asyncDispose]).toHaveBeenCalledOnce();
});

it("releases a lease handed over before publication fails", async () => {
  const dispatchLease = lease("dispatch");
  prepared.load.mockImplementation(async (params: { onRuntimeLease: (l: unknown) => void }) => {
    params.onRuntimeLease(dispatchLease);
    throw new Error("synthetic publication failure");
  });
  const run = vi.fn();
  await expect(withTalkConsultPublishedRuntime(target, run)).rejects.toThrow(
    "synthetic publication failure",
  );
  expect(dispatchLease[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
});

it("falls back to the command owner's loading when the agent has no published owner", async () => {
  const { PreparedModelRuntimeOwnerNotPublishedError } =
    await import("../../agents/prepared-model-runtime-admission-errors.js");
  prepared.load.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError("unpublished"));
  const run = vi.fn(async (context: unknown) => context);
  await expect(withTalkConsultPublishedRuntime(target, run)).resolves.toBeUndefined();
  expect(run).toHaveBeenCalledOnce();
});
