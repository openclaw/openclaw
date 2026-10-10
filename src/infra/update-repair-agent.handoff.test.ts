import { afterEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { createExternalAuthRuntime } from "../agents/auth-profiles/external-auth.js";
import { createAuthProfileStoreRuntime } from "../agents/auth-profiles/store.js";
import type { StreamFn } from "../agents/runtime/index.js";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";
import { runUpdateRepairTurn } from "./update-repair-agent.runtime.js";

const fixture = vi.hoisted(() => ({
  stream: vi.fn<StreamFn>(),
  handoff: undefined as ReturnType<typeof createManagedHandoffTestBinding> | undefined,
}));
// Only inference is synthetic; admission, tool preparation/execution, terminal
// resolution, auth bookkeeping, and database lifecycle are production owners.
vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: () => fixture.stream,
}));
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => {
    if (!fixture.handoff) {
      throw new Error("Private handoff binding required");
    }
    fixture.handoff.assertPath();
    return fixture.handoff.directory;
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  fixture.handoff = undefined;
  fixture.stream.mockReset();
});

it("settles the real repair handoff without closing a parent lease before Doctor admission", async () => {
  await withOpenClawTestState({ layout: "home" }, async (state) => {
    fixture.handoff = createManagedHandoffTestBinding(state.root);
    vi.stubEnv(
      "NODE_OPTIONS",
      [process.env.NODE_OPTIONS, fixture.handoff.nodeOption].filter(Boolean).join(" "),
    );
    expect(fixture.handoff.assertPath(resolveManagedUpdateLeaseDatabasePath())).toBe(
      fixture.handoff.databasePath,
    );
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
    const agentDir = state.agentDir("owner");
    const auth = createAuthProfileStoreRuntime(createExternalAuthRuntime(() => []));
    const seed = createOpenClawDatabaseMaintenanceScope();
    try {
      seed.run(() =>
        auth.saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "fixture:repair": { type: "token", provider: "fixture", token: "synthetic-token" },
            },
          },
          agentDir,
        ),
      );
    } finally {
      await seed.close();
    }
    expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toEqual([]);
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { skipBootstrap: true }, entries: { owner: { agentDir } } },
      tools: { toolSearch: { enabled: false } },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://repair.invalid/v1",
            api: "openai-responses",
            models: [
              {
                id: "repair",
                name: "Synthetic repair",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    };
    await state.writeConfig(config);
    fixture.stream.mockImplementation((model, context) => {
      expect(context.tools?.map((tool) => tool.name)).toContain("request_update_maintenance");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "maintenance-request",
                name: "request_update_maintenance",
                arguments: { operation: "doctor-fix" },
              },
            ],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        });
        stream.end();
      });
      return stream;
    });
    // Cold module loading is outside the deterministic model turn budget. The
    // automatic caller allows ten minutes; this fixture exercises one immediate inference.
    await Promise.all([
      import("../agents/embedded-agent.js"),
      import("../agents/embedded-agent-runner/run-entry.js"),
    ]);
    const parent = createOpenClawDatabaseMaintenanceScope();
    try {
      parent.run(() =>
        auth.saveAuthProfileStore({ version: 1, profiles: {} }, state.agentDir("independent")),
      );
      const result = await parent.run(() =>
        runUpdateRepairTurn({
          target: { ...state, installRoot: state.workspaceDir },
          route: {
            runner: "embedded",
            provider: "fixture",
            model: "repair",
            modelLabel: "fixture/repair",
            agentId: "owner",
            agentDir,
            authProfileId: "fixture:repair",
            runConfig: config,
            sourceConfig: config,
          },
          modelFallbacks: [],
          prompt: "Request Doctor repair using the maintenance tool.",
          timeoutMs: 30000,
          maxToolCalls: 1,
          signal: new AbortController().signal,
          maintenanceHandoff: true,
        }),
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        envelope: { status: "ok" },
        maintenance: { operation: "doctor-fix" },
      });
      expect(fixture.stream).toHaveBeenCalledTimes(1);
      // These checks must precede fixture teardown: cleanup must not hide a leaked lease.
      expect(
        readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env }).map(
          (lease) => lease.agent_id,
        ),
      ).toEqual(["independent"]);
      const saved = auth.loadAuthProfileStoreForRuntime(agentDir, {
        readOnly: true,
        externalCli: { mode: "none" },
      });
      expect(saved.usageStats?.["fixture:repair"]?.lastUsed).toBeGreaterThan(0);
      const admitDoctor = () =>
        beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        });
      await expect(admitDoctor()).rejects.toMatchObject({
        refusal: { kind: "deferred", reason: "agent-database-in-use" },
      });
      await parent.close();
      expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toEqual([]);
      const doctor = await admitDoctor();
      expect(doctor).toBeDefined();
      try {
        doctor!.run(() => auth.saveAuthProfileStore(saved, agentDir));
      } finally {
        await doctor?.release();
      }
      expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toEqual([]);
      expect(
        auth.loadAuthProfileStoreForRuntime(agentDir, {
          readOnly: true,
          externalCli: { mode: "none" },
        }),
      ).toEqual(saved);
    } finally {
      await parent.close();
    }
  });
});
