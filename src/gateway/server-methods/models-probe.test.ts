import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { AuthProbeSummary } from "../../commands/models/list.probe.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  listAgentIds: vi.fn(() => ["main", "writer"]),
  resolveAgentDir: vi.fn((_cfg: unknown, agentId: string) => `/tmp/agent-${agentId}`),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn((_cfg: unknown, agentId: string) => `/tmp/workspace-${agentId}`),
  runAuthProbes: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../commands/models/list.probe.js", async () => {
  const actual = await vi.importActual<typeof import("../../commands/models/list.probe.js")>(
    "../../commands/models/list.probe.js",
  );
  return { ...actual, runAuthProbes: mocks.runAuthProbes };
});

import { modelsProbeHandlers } from "./models-probe.js";

const handler = expectDefined(modelsProbeHandlers["models.probe"], "models.probe handler");

function summary(results: AuthProbeSummary["results"]): AuthProbeSummary {
  return {
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    totalTargets: results.length,
    options: { timeoutMs: 20_000, concurrency: 2, maxTokens: 8 },
    results,
  };
}

async function probe(params: Record<string, unknown>, cfg: OpenClawConfig = {}) {
  const respond = vi.fn();
  const warn = vi.fn();
  await handler({
    req: { type: "req", id: "probe-1", method: "models.probe", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => cfg, logGateway: { warn } } as never,
  } as GatewayRequestHandlerOptions);
  return { respond, warn };
}

function expectFailure(respond: ReturnType<typeof vi.fn>, error: object) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function expectProbe(fields: object) {
  expect(mocks.runAuthProbes).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function expectSuccess(respond: ReturnType<typeof vi.fn>, result: object) {
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
}

function target(
  overrides: Partial<AuthProbeSummary["results"][number]>,
): AuthProbeSummary["results"][number] {
  return { provider: "openai", label: "env", source: "profile", status: "ok", ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAgentIds.mockReturnValue(["main", "writer"]);
  mocks.resolveDefaultAgentId.mockReturnValue("main");
  mocks.runAuthProbes.mockReset();
  mocks.runAuthProbes.mockResolvedValue(summary([]));
});

it("rejects invalid parameters before running a probe", async () => {
  const { respond } = await probe({ provider: "openai", extra: true });
  expectFailure(respond, { code: "INVALID_REQUEST" });
  expect(mocks.runAuthProbes).not.toHaveBeenCalled();
});

it("returns typed selection-required when agentId is omitted", async () => {
  mocks.resolveDefaultAgentId.mockImplementationOnce(() => {
    throw new AgentSelectionRequiredError(["main", "writer"], {
      surface: "model auth",
      hint: "Pass agentId to select a configured agent.",
    });
  });
  const { respond } = await probe({ provider: "openai" });
  expectFailure(respond, {
    code: "INVALID_REQUEST",
    message: expect.stringContaining("agent"),
  });
  expect(mocks.runAuthProbes).not.toHaveBeenCalled();
});

it("normalizes providers, trims profiles, and clamps the timeout", async () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6", fallbacks: ["openai/gpt-5.5"] },
        utilityModel: {
          primary: "openai/gpt-5.6-luna",
          fallbacks: ["local/backup"],
        },
      },
    },
  };
  await probe({ provider: " OpenAI ", profileId: " work ", timeoutMs: 1 }, cfg);
  expect(mocks.runAuthProbes).toHaveBeenCalledWith({
    cfg,
    agentId: "main",
    agentDir: "/tmp/agent-main",
    workspaceDir: "/tmp/workspace-main",
    providers: ["openai"],
    modelCandidates: ["openai/gpt-5.6", "openai/gpt-5.5", "openai/gpt-5.6-luna", "local/backup"],
    options: {
      provider: "openai",
      profileIds: ["work"],
      timeoutMs: 5_000,
      concurrency: 2,
      maxTokens: 8,
    },
  });
});

it("probes the default agent without a configured model when agentId is empty", async () => {
  await probe({ provider: "openai", agentId: "" });
  expectProbe({
    cfg: {},
    providers: ["openai"],
    modelCandidates: [],
    agentId: "main",
    agentDir: "/tmp/agent-main",
    workspaceDir: "/tmp/workspace-main",
  });
});

it("probes an explicit configured agent", async () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        utilityModel: { primary: "openai/small", fallbacks: ["openai/default-backup"] },
      },
      entries: { main: {}, writer: { utilityModel: { fallbacks: ["openai/writer-backup"] } } },
    },
  };
  await probe({ provider: "openai", agentId: "Writer" }, cfg);
  expectProbe({
    agentId: "writer",
    agentDir: "/tmp/agent-writer",
    workspaceDir: "/tmp/workspace-writer",
    modelCandidates: ["openai/small", "openai/writer-backup"],
  });
});

it.each(["retired", "   "])("rejects explicit unknown agentId %j", async (agentId) => {
  mocks.listAgentIds.mockReturnValue(["main"]);
  const { respond } = await probe({ provider: "openai", agentId });
  expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
  expect(mocks.runAuthProbes).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(false, undefined, {
    code: "INVALID_REQUEST",
    message: `unknown agent id "${agentId}"`,
    details: { code: "UNKNOWN_AGENT_ID", agentId },
  });
});

it("probes the requested provider so overrides and model selection resolve", async () => {
  const cfg: OpenClawConfig = {
    auth: {
      order: { byteplus: ["byteplus:plan"] },
    },
    agents: { defaults: { model: { primary: "byteplus-plan/ark-code-latest" } } },
  };
  const { respond } = await probe({ provider: "byteplus-plan" }, cfg);
  expectProbe({
    cfg,
    providers: ["byteplus-plan"],
    modelCandidates: ["byteplus-plan/ark-code-latest"],
    options: expect.objectContaining({ provider: "byteplus-plan" }),
  });
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ provider: "byteplus-plan" }),
    undefined,
  );
});

it("maps target results and reports provider success when one credential works", async () => {
  mocks.runAuthProbes.mockResolvedValue(
    summary([
      target({ profileId: "old", label: "Old", status: "auth", error: "expired", latencyMs: 20 }),
      target({ profileId: "work", label: "Work", latencyMs: 125 }),
    ]),
  );
  const { respond } = await probe({ provider: "openai", timeoutMs: 90_000 });
  expectProbe({
    options: expect.objectContaining({ includeDirectKeys: true, timeoutMs: 60_000 }),
  });
  expectSuccess(respond, {
    provider: "openai",
    status: "ok",
    latencyMs: 125,
    results: [
      {
        profileId: "old",
        label: "Profile Old",
        status: "auth",
        latencyMs: 20,
        error: "Authentication failed.",
      },
      { profileId: "work", label: "Profile Work", status: "ok", latencyMs: 125 },
    ],
  });
});

it("names mixed probe routes and keeps preflight failures actionable", async () => {
  mocks.runAuthProbes.mockResolvedValue(
    summary([
      target({
        provider: "ollama",
        model: "ollama/gemma4:latest",
        label: "config",
        source: "models.json",
        status: "unknown",
        reasonCode: "unresolved_ref",
        error: "Configured API key could not be resolved.",
      }),
      target({
        provider: "ollama",
        model: "ollama/gemma4:latest",
        profileId: "ollama:default",
        label: "ollama:default",
        latencyMs: 16121,
      }),
    ]),
  );
  const cfg = {
    agents: { defaults: { model: { primary: "ollama/gemma4:latest" } } },
  } satisfies OpenClawConfig;
  const { respond } = await probe({ provider: "ollama" }, cfg);
  expectSuccess(respond, {
    provider: "ollama",
    status: "ok",
    latencyMs: 16121,
    results: [
      {
        label: "Configured credential · ollama/gemma4:latest",
        status: "unknown",
        error: "The configured credential could not be resolved. Update or remove it, then retry.",
      },
      {
        profileId: "ollama:default",
        label: "Profile ollama:default · ollama/gemma4:latest",
        status: "ok",
        latencyMs: 16121,
      },
    ],
  });
});

it("redacts credential-shaped text from target and provider errors", async () => {
  const secret = ["AI", "za", "SyOpaqueProviderCredential"].join("");
  mocks.runAuthProbes.mockResolvedValue(
    summary([target({ source: "env", status: "auth", error: `request rejected for ${secret}` })]),
  );
  const { respond } = await probe({ provider: "openai" });
  const payload = respond.mock.calls[0]?.[1];
  expect(payload).toMatchObject({ provider: "openai", status: "auth" });
  expect(JSON.stringify(payload)).not.toContain(secret);
  expect(JSON.stringify(payload)).toContain("Authentication failed.");
});

it("records a redacted typed diagnostic when probe execution fails", async () => {
  const secret = ["AI", "za", "SyOpaqueProviderCredential"].join("");
  mocks.runAuthProbes.mockRejectedValue(new Error(`runtime failed for ${secret}`));
  const { respond, warn } = await probe({ provider: "ollama", timeoutMs: 9_000 });
  expectFailure(respond, { code: "UNAVAILABLE", message: "Connection check failed." });
  expect(warn).toHaveBeenCalledWith("Model connection check failed.", {
    event: "models_probe_failed",
    provider: "ollama",
    timeoutMs: 9_000,
    error: expect.stringContaining("runtime failed for"),
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
});
