import { expect, it, vi } from "vitest";
import * as harnessPolicy from "../agents/harness/policy.js";
import { registerAgentHarness } from "../agents/harness/registry.js";
import * as thinkingRuntime from "../agents/thinking-runtime.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { filterSessionEntries } from "./session-list-filters.js";
import { writeRow } from "./session-row-projection-read-fixtures.test-support.js";
import { withSessionRowProjectionState } from "./session-row-projection.test-support.js";
import { prepareSessionRowSelection } from "./session-utils-list.js";

it("shares runtime decisions while projecting a cold page in one materialization slice", async () => {
  await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
    withSessionRowProjectionState(async (create) => {
      const cfg: OpenClawConfig = { agents: { defaults: { model: "fixture/first" } } };
      setRuntimeConfigSnapshot(cfg);
      const queries = Array.from({ length: 12 }, (_, index) => ({
        agentId: "main",
        key: `agent:main:archived-${index}`,
      }));
      for (const { key } of queries) {
        writeRow(key, { archivedAt: 1 });
      }
      const projection = await create({ cfg, modelCatalog: [] });
      await projection.prepareSelection();
      using effective = vi.spyOn(thinkingRuntime, "resolveEffectiveAgentRuntime");
      using policy = vi.spyOn(harnessPolicy, "resolveAgentHarnessPolicy");
      // Keep this work-count proof in one slice regardless of host speed.
      using clock = vi.spyOn(performance, "now");
      clock.mockReturnValue(0);
      const rows = await projection.withPreparedExactRows(
        () => queries,
        () => queries.map((query) => projection.snapshot(query).row),
      );
      expect(rows).toHaveLength(12);
      expect(rows.every((row) => row?.agentRuntime?.id === "openclaw")).toBe(true);
      expect(effective).toHaveBeenCalledTimes(1);
      expect(policy).toHaveBeenCalledTimes(2);
    }, true),
  );
});

it("resolves cold search runtimes per agent and selection, observing later runtime and config changes", async () => {
  await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
    withSessionRowProjectionState(async (create) => {
      const runtime = "fixture-runtime";
      const register = (supported: boolean) =>
        registerAgentHarness({
          id: runtime,
          label: "Fixture runtime",
          supports: () => ({ supported, fallbackRuntime: "openclaw" }),
          runAttempt: async () => {
            throw new Error("Search must not run an agent");
          },
        });
      register(true);
      const models = (first: string, second: string) => ({
        "fixture/first": { agentRuntime: { id: first } },
        "fixture/second": { agentRuntime: { id: second } },
      });
      let cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "fixture/first" },
          entries: {
            alpha: { models: models("openclaw", runtime) },
            beta: { models: models(runtime, "openclaw") },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const variants: Array<[string, Partial<SessionEntry>]> = [
        ["default", {}],
        ["model", { providerOverride: "fixture", modelOverride: "second" }],
        ["pinned", { agentHarnessId: runtime, modelSelectionLocked: true }],
        [
          "plugin",
          { agentHarnessId: runtime, modelSelectionLocked: true, pluginOwnerId: "fixture" },
        ],
        ["override", { agentRuntimeOverride: runtime }],
      ];
      for (const agentId of ["alpha", "beta"]) {
        for (const [variant, entry] of variants) {
          for (let index = 0; index < 12; index++) {
            writeRow(`agent:${agentId}:${variant}-${index}`, { archivedAt: 1, ...entry }, agentId);
          }
        }
      }
      const projection = await create({ cfg, getConfig: () => cfg, modelCatalog: [] });
      const read = async () => {
        await projection.prepareSelection();
        return filterSessionEntries(
          prepareSessionRowSelection(
            projection,
            { search: "openclaw", archived: true },
            { metadataPrepared: true },
          ),
        ).entries.map(([key]) => key);
      };
      await projection.prepareSelection();
      using effective = vi.spyOn(thinkingRuntime, "resolveEffectiveAgentRuntime");
      using policy = vi.spyOn(harnessPolicy, "resolveAgentHarnessPolicy");
      const first = await read();
      expect(first).toHaveLength(36);
      expect(first.every((key) => /^agent:(alpha:(default|plugin)|beta:model)-/u.test(key))).toBe(
        true,
      );
      expect(effective).toHaveBeenCalledTimes(8);
      expect(policy).toHaveBeenCalledTimes(16);
      expect(
        Object.fromEntries(
          ["alpha", "beta"].map((agentId) => [
            agentId,
            effective.mock.calls.filter(([params]) => params.agentScope?.agentId === agentId)
              .length,
          ]),
        ),
      ).toEqual({ alpha: 4, beta: 4 });

      register(false);
      expect(await read()).toHaveLength(96);
      register(true);
      cfg = {
        ...cfg,
        agents: {
          ...cfg.agents,
          entries: {
            ...cfg.agents!.entries,
            alpha: { models: models(runtime, runtime) },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const changed = await read();
      expect(changed).toHaveLength(12);
      expect(changed.every((key) => key.startsWith("agent:beta:model-"))).toBe(true);
    }, true),
  );
});
