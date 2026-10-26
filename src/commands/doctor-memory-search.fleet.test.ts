import path from "node:path";
import { expect, it } from "vitest";
import { withSuppressedNotes } from "../../packages/terminal-core/src/note.js";
import { createDoctorHealthFlowContext } from "../flows/doctor-health-context.test-support.js";
import { runMemorySearchHealthContribution } from "../flows/doctor-health-contribution-runners.workspace.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectMemorySearchHealthFindings } from "./doctor-memory-search.js";

it.each(["health", "contribution"] as const)(
  "%s shares memory registrations across empty workspaces and preserves workspace owners",
  (phase) =>
    withOpenClawTestState({ env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } }, async (state) => {
      const event = `doctor-memory-registration:${state.root}`;
      const registrations: string[] = [];
      const registered = (owner: string) => registrations.push(owner);
      for (const [directory, owner] of [
        [state.statePath("extensions/fleet-memory"), "shared"],
        [state.path("workspace-special/.openclaw/extensions/fleet-memory"), "workspace"],
      ] as const) {
        const relative = path.relative(state.stateDir, directory);
        await state.writeJson(`${relative}/openclaw.plugin.json`, {
          id: "fleet-memory",
          kind: "memory",
          configSchema: { type: "object", additionalProperties: false },
        });
        await state.writeText(
          `${relative}/index.cjs`,
          `module.exports = { id: "fleet-memory", kind: "memory", register(api) {
            process.emit(${JSON.stringify(event)}, ${JSON.stringify(owner)});
            api.registerMemoryCapability({ runtime: {
              getMemorySearchManager: async () => ({ manager: null }),
              resolveMemoryBackendConfig: () => ({ backend: "builtin" })
            } });
          } };`,
        );
      }
      const entries = Object.fromEntries(
        Array.from({ length: 201 }, (_, i) => {
          const id = i === 100 ? "special" : `agent${i}`;
          return [id, { workspace: state.path(i === 100 ? "workspace-special" : `workspace${i}`) }];
        }),
      );
      process.on(event, registered);
      await using cache = createPluginCache();
      try {
        await withPluginCache(cache, async () => {
          const cfg = {
            agents: { entries },
            memory: { search: { provider: "none", rememberAcrossConversations: false } },
            plugins: {
              allow: ["fleet-memory"],
              entries: { "fleet-memory": { enabled: true } },
              slots: { memory: "fleet-memory" },
            },
          };
          const context = {
            mode: "lint",
            cfg,
            env: state.env,
            runtime: { log() {}, error() {}, exit() {} },
          } as const;
          if (phase === "health") {
            expect(await collectMemorySearchHealthFindings(context)).toEqual([]);
          } else {
            await withSuppressedNotes(() =>
              runMemorySearchHealthContribution(createDoctorHealthFlowContext(context)),
            );
          }
        });
      } finally {
        process.off(event, registered);
      }
      expect(registrations.toSorted()).toEqual(["shared", "workspace"]);
    }),
);
