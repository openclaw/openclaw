import { expect, it } from "vitest";
import { createAttachedBrowserToolRuntime } from "../extensions/browser/runtime-api.js";
import { createOpenClawCodingToolsInternalAsync } from "../src/agents/agent-tools.js";
import type { SessionPlacementTurnParams } from "../src/agents/session-placement-admission.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  readRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.js";
import { prepareWorkerDesktopLaunchPlan } from "../src/gateway/worker-environments/worker-desktop-launch-plan.js";
import { resolveWorkerToolAuthority } from "../src/gateway/worker-environments/worker-tool-authority.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { createWorkerBrowserToolRuntime } from "../src/worker/browser-runtime.js";
import { createWorkerPlacementTools } from "../src/worker/worker-placement-tools.js";

it("executes the admitted worker Browser with private config and no host authority", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: false },
    async (state) => {
      const sessionKey = "agent:main:dashboard:worker-browser";
      const storePath = state.statePath("sessions.sqlite");
      await upsertSessionEntryCore(
        { agentId: "main", storePath, sessionKey },
        { sessionId: "worker-browser", updatedAt: 1 },
      );
      const turn = {
        config: {
          session: { store: storePath },
          plugins: { allow: ["browser"] },
          tools: { allow: ["read", "browser"], codeMode: { enabled: false } },
        },
        agentId: "main",
        sessionKey,
        sessionId: "worker-browser",
        sessionFile: state.statePath("session.jsonl"),
        workspaceDir: state.workspaceDir,
        prompt: "synthetic pre-inference Browser probe",
        timeoutMs: 1_000,
        runId: "worker-browser",
        toolsAllow: ["read", "browser"],
      } satisfies SessionPlacementTurnParams;
      const assertCurrent = () => {};
      // Prepare capability metadata through its durable owner, then apply the real
      // desktop policy before materializing the executable placement tool.
      const authority = await resolveWorkerToolAuthority({
        modelRef: { provider: "openai", model: "synthetic-model" },
        turn,
        placement: { agentId: "main", sessionKey },
        assertCurrent,
      });
      const desktop = await prepareWorkerDesktopLaunchPlan({
        desktop: {
          protocol: "rfb",
          port: 5900,
          apps: [
            {
              id: "browser",
              executablePath: process.execPath,
              args: ["-e", "process.exit(1)"],
              cdpPort: 1,
            },
          ],
        },
        protocolFeatures: [],
        prepareComputer: () => undefined,
        turn,
      });
      expect(desktop.browser).toBeDefined();
      const local = createWorkerPlacementTools({
        ...turn,
        cwd: state.workspaceDir,
        containmentRoot: state.workspaceDir,
        policy: authority.policy,
        execAuthority: authority.exec,
      });
      const tools = await createOpenClawCodingToolsInternalAsync(
        {
          ...turn,
          conversationCapabilityProfile: authority.capabilityProfile,
          wrapBeforeToolCallHook: false,
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: false,
          },
        },
        undefined,
        undefined,
        { tools: [...local, ...desktop.tools], policy: authority.policy },
        { assertCurrent },
      );
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(["browser", "read"]);
      clearRuntimeConfigSnapshot();
      expect(getRuntimeConfigSnapshot()).toBeNull();
      const browser = await createWorkerBrowserToolRuntime({
        descriptor: desktop.browser!,
        sessionKey,
        stateDir: state.stateDir,
        workspaceDir: state.workspaceDir,
        // This is the same public Browser runtime used by worker build composition.
        runtime: { createAttachedBrowserToolRuntime },
      });
      try {
        for (const hostConfigPresent of [false, true]) {
          if (hostConfigPresent) {
            setRuntimeConfigSnapshot({
              browser: {
                enabled: false,
                defaultProfile: "host-only",
                profiles: { "host-only": { driver: "existing-session" } },
              },
              gateway: { nodes: { browser: { mode: "manual", node: "host-node" } } },
            });
          }
          const status = await browser.tool.execute("status", { action: "status" });
          expect(status.details).toMatchObject({
            enabled: true,
            profile: "worker",
            attachOnly: true,
            cdpPort: 1,
            running: false,
          });
          const profiles = await browser.tool.execute("profiles", { action: "profiles" });
          expect(profiles.details).toMatchObject({ profiles: [{ name: "worker" }] });
          expect(JSON.stringify(profiles)).not.toContain("host-only");
          await expect(
            browser.tool.execute("host", { action: "status", target: "host" }),
          ).rejects.toThrow("Host browser control is disabled");
          await expect(
            browser.tool.execute("node", { action: "status", target: "node" }),
          ).rejects.toThrow("Node browser control is disabled");
          // Reach the real snapshot route without a browser process: the failing
          // synthetic launcher must remain the boundary, rather than global config.
          await expect(browser.tool.execute("snapshot", { action: "snapshot" })).rejects.toThrow(
            "Worker Browser launcher failed",
          );
          if (!hostConfigPresent) {
            expect(getRuntimeConfigSnapshot()).toBeNull();
            expect(() => readRuntimeConfig()).toThrow("Runtime config is not prepared");
          }
        }
      } finally {
        await browser.dispose();
      }
    },
  );
});
