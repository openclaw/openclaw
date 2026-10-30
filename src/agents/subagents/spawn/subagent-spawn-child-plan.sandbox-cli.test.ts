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

// Host CLI execution cannot honor a child's container sandbox.
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
    const defaults = { workspace: stateDir, model: { primary: "openai/gpt-5.4" } };
    const sandbox = params.sandboxMode ? { sandbox: { mode: params.sandboxMode } } : {};
    const cfg: OpenClawConfig = {
      logging: { audit: { enabled: false } },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: {
        defaults: { ...defaults, ...sandbox },
        entries: {
          main: {
            workspace: stateDir,
            ...sandbox,
            subagents: params.visibleWorker
              ? { allowAgents: ["worker"] }
              : params.childModel
                ? { model: params.childModel }
                : undefined,
          },
          ...(params.visibleWorker
            ? {
                worker: {
                  workspace: stateDir,
                  sandbox: { mode: "all" as const },
                  subagents: { model: "test-cli/haiku" },
                },
              }
            : {}),
        },
        ...(params.visibleWorker ? { ownership: "explicit" as const } : {}),
      },
    };
    await fixture.configure(cfg);
  }

  async function checkChildPlan(
    params: {
      childModel?: string;
      sandboxMode?: "off" | "all";
      sandbox?: "inherit" | "require";
    },
    check: (plan: Awaited<ReturnType<typeof resolveSubagentChildPlan>>) => void,
  ) {
    await configureSpawnConfig(params);
    await fixture.writeSession(fixture.parentSessionKey, "sandbox-cli-requester");
    const request = { task: "delegated containment work", context: "isolated" as const };
    const ctx = { agentSessionKey: fixture.parentSessionKey };
    const preparation = await resolveSubagentSpawnRequest(request, ctx);
    if (!preparation.ok) {
      throw new Error(JSON.stringify(preparation.result));
    }
    try {
      check(
        await resolveSubagentChildPlan({
          ...preparation.resolved,
          request,
          ctx,
          sandboxMode: params.sandbox ?? "require",
          swarmEnabled: false,
        }),
      );
    } finally {
      preparation.resolved.admissionReservation?.release();
    }
  }

  it("rejects a sandbox-classified child whose resolved model runs on a host CLI backend", async () => {
    await checkChildPlan({ childModel: "test-cli/haiku", sandboxMode: "all" }, (plan) => {
      expect(plan).toMatchObject({ ok: false, result: { status: "forbidden" } });
      if (plan.ok) {
        throw new Error("Expected the sandboxed CLI child to be rejected");
      }
      expect(plan.result.error).toContain("test-cli");
      expect(plan.result.error).toContain("cannot honor the sandbox");
    });
  });

  it.each([
    { sandboxMode: "all", sandbox: "require", childModel: undefined, model: "openai/gpt-5.4" },
    {
      sandboxMode: undefined,
      sandbox: "inherit",
      childModel: "test-cli/haiku",
      model: "test-cli/haiku",
    },
  ] as const)("admits $model with sandbox=$sandboxMode", async ({ model, ...params }) => {
    await checkChildPlan(params, (plan) => {
      if (!plan.ok) {
        throw new Error(JSON.stringify(plan.result));
      }
      expect(plan.resolved).toMatchObject({
        childRuntimeSandboxed: params.sandboxMode === "all",
        resolvedModelMetadata: {
          resolvedProvider: params.sandboxMode === "all" ? "openai" : "test-cli",
          resolvedModel: model,
        },
      });
    });
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
