import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDoctorHealthFlowContext } from "../flows/doctor-health-context.test-support.js";
import { runMemorySearchHealthContribution } from "../flows/doctor-health-contribution-runners.workspace.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectMemorySearchHealthFindings } from "./doctor-memory-search.js";

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: vi.fn(),
}));

it.each(["health", "contribution"] as const)(
  "%s shares memory registrations across empty workspaces and preserves workspace owners",
  async (phase) => {
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
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
              resolveMemoryBackendConfig: () => {
                return { backend: "builtin" };
              }
            } });
          } };`,
          );
        }
        const agents = Array.from(
          { length: 200 },
          (_, i) => [`agent${i}`, { workspace: state.path(`workspace${i}`) }] as const,
        );
        const entries = Object.fromEntries([
          ...agents.slice(0, 100),
          ["special", { workspace: state.path("workspace-special") }],
          ...agents.slice(100),
        ]);
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
              await runMemorySearchHealthContribution(createDoctorHealthFlowContext(context));
            }
          });
        } finally {
          process.off(event, registered);
        }
        expect(registrations.toSorted()).toEqual(["shared", "workspace"]);
      },
    );
  },
);
