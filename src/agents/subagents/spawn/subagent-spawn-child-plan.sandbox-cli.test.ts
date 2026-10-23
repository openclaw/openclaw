import "./subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { installSpawnAuthorityFixture } from "./subagent-spawn.authority.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { testing as cliBackendsTesting } from "../../cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../../cli-runner.test-helpers.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();

function useInProcessSpawns() {
  spawnTesting.setDepsForTest({
    hasInProcessGatewayContext: () => true,
    resolveContextEngine: async () => new LegacyContextEngine(),
    dispatchGatewayMethodInProcess: async (method: string) => {
      throw new Error(`Unexpected spawn RPC ${method}`);
    },
  });
}

/**
 * Sandboxed delegated children must never resolve to a host-executed CLI
 * backend: the CLI runs as the Gateway OS user outside the configured
 * container while the session is reported sandboxed. The spawn gate decides
 * on the config-derived classification before model resolution, so admission
 * re-checks once the child runtime is knowable.
 */
describe("subagent spawn sandbox-CLI admission", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: (() => [buildDefaultTestCliBackend()]) as never,
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  async function configureSpawnConfig(params: {
    sandboxMode?: "off" | "all";
    childModel?: string;
    visibleWorker?: boolean;
  }) {
    const stateDir = fixture.stateDir;
    const cfg: OpenClawConfig = {
      logging: { audit: { enabled: false } },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: params.visibleWorker
        ? {
            ownership: "explicit",
            defaults: {
              workspace: stateDir,
              model: { primary: "openai/gpt-5.4" },
            },
            entries: {
              main: {
                workspace: stateDir,
                subagents: { allowAgents: ["worker"] },
              },
              worker: {
                workspace: stateDir,
                sandbox: { mode: "all" },
                subagents: { model: "test-cli/haiku" },
              },
            },
          }
        : {
            defaults: {
              workspace: stateDir,
              model: { primary: "openai/gpt-5.4" },
              ...(params.sandboxMode ? { sandbox: { mode: params.sandboxMode } } : {}),
            },
            entries: {
              main: {
                workspace: stateDir,
                ...(params.sandboxMode ? { sandbox: { mode: params.sandboxMode } } : {}),
                ...(params.childModel ? { subagents: { model: params.childModel } } : {}),
              },
            },
          },
      models: {
        providers: {
          "test-cli": {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            models: [
              {
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                id: "haiku",
                input: ["text"],
                maxTokens: 1_024,
                name: "Haiku",
                reasoning: false,
              },
            ],
          },
        },
      },
    };
    await fixture.configure(cfg);
  }

  async function planChildSpawn(params: {
    childModel?: string;
    sandboxMode?: "off" | "all";
    sandbox?: "inherit" | "require";
  }) {
    await configureSpawnConfig({
      sandboxMode: params.sandboxMode,
      childModel: params.childModel,
    });
    await fixture.writeSession(fixture.parentSessionKey, "sandbox-cli-requester");
    const request = { task: "delegated containment work", context: "isolated" as const };
    const ctx = { agentSessionKey: fixture.parentSessionKey };
    const preparation = await resolveSubagentSpawnRequest(request, ctx);
    if (!preparation.ok) {
      throw new Error(JSON.stringify(preparation.result));
    }
    try {
      const plan = await resolveSubagentChildPlan({
        ...preparation.resolved,
        request,
        ctx,
        sandboxMode: params.sandbox ?? "require",
        swarmEnabled: false,
      });
      return { plan, preparation };
    } catch (err) {
      preparation.resolved.admissionReservation?.release();
      throw err;
    }
  }

  it("rejects a sandbox-classified child whose resolved model runs on a host CLI backend", async () => {
    const { plan, preparation } = await planChildSpawn({
      childModel: "test-cli/haiku",
      sandboxMode: "all",
      sandbox: "require",
    });
    try {
      expect(plan).toMatchObject({
        ok: false,
        result: { status: "forbidden" },
      });
      if (plan.ok) {
        throw new Error("Expected the sandboxed CLI child to be rejected");
      }
      expect(plan.result.error).toContain("test-cli");
      expect(plan.result.error).toContain("cannot honor the sandbox");
    } finally {
      preparation.resolved.admissionReservation?.release();
    }
  });

  it("admits a sandbox-classified child with an embedded/API model", async () => {
    const { plan, preparation } = await planChildSpawn({ sandboxMode: "all" });
    try {
      if (!plan.ok) {
        throw new Error(JSON.stringify(plan.result));
      }
      expect(plan.resolved.childRuntimeSandboxed).toBe(true);
      expect(plan.resolved.resolvedModelMetadata.resolvedProvider).toBe("openai");
    } finally {
      preparation.resolved.admissionReservation?.release();
    }
  });

  it("keeps CLI-backed children admitted when no sandbox classification applies", async () => {
    const { plan, preparation } = await planChildSpawn({
      childModel: "test-cli/haiku",
      sandbox: "inherit",
    });
    try {
      if (!plan.ok) {
        throw new Error(JSON.stringify(plan.result));
      }
      expect(plan.resolved.childRuntimeSandboxed).toBe(false);
      expect(plan.resolved.resolvedModelMetadata.resolvedModel).toBe("test-cli/haiku");
    } finally {
      preparation.resolved.admissionReservation?.release();
    }
  });

  it("rejects a sandbox-classified visible child whose model runs on a host CLI backend", async () => {
    useInProcessSpawns();
    await configureSpawnConfig({ visibleWorker: true });
    const controllerKey = "agent:main:dashboard:controller";
    await fixture.writeSession(controllerKey, "controller-session");
    const callGateway = vi.fn(async () => {
      throw new Error("sessions.create must not run for a CLI-backed sandboxed child");
    });
    const result = await maybeSpawnVisibleSession({
      raw: { visible: true },
      requestedAgentId: "worker",
      task: "visible delegated containment work",
      label: "",
      runtime: "subagent",
      sandbox: "require",
      expectsCompletionMessage: true,
      options: {
        agentSessionKey: controllerKey,
        config: getRuntimeConfig(),
        callGateway: callGateway as never,
      },
    });
    expect(result).toMatchObject({ status: "forbidden" });
    expect((result as { error?: string }).error).toContain("test-cli");
    expect((result as { error?: string }).error).toContain("cannot honor the sandbox");
    expect(callGateway).not.toHaveBeenCalled();
  });
});
