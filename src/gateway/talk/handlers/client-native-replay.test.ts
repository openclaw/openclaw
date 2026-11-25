import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createExecTool } from "../../../agents/bash-tools.js";
import type { EmbeddedAgentRunResult } from "../../../agents/embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../../../agents/harness/host-capability.js";
import { projectEffectiveExecPolicy } from "../../../agents/session-permission-exec-mode.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveClientVoiceRunBinding } from "../../../talk/client-voice-session.js";
import {
  AGENT_ID,
  connectNativeSession,
  installNativePluginTestHooks,
  nativeDelegation,
  nativeResult,
  upstream,
  withNativePlugin,
} from "./client-native-control.test-support.js";
import { withRegisteredNativeEmbeddedRun } from "./client-native-run.test-support.js";

installNativePluginTestHooks();

// This entry-point proof executes a real Linux shell; provider lifecycle controls are portable.
it.runIf(process.platform === "linux")(
  "registered native delegation replay dispatches a completed subscription delegation once while allowing fresh IDs",
  async () => {
    const admitted = vi.fn();
    const effects: unknown[] = [];
    const runIds: string[] = [];
    let marker = "";
    const failed = createDeferredCore<never>();
    void failed.promise.catch(() => {});
    upstream.runEmbeddedAgent.mockImplementation(async (params) =>
      withRegisteredNativeEmbeddedRun(params, async (admittedRunContext) => {
        expect(resolveClientVoiceRunBinding(params.runId)).toBeDefined();
        const { sessionId, sessionKey, runId, workspaceDir, cwd, config } = params;
        const identity = { agentId: AGENT_ID, sessionId, sessionKey, runId };
        const text = "Native effect completed.";
        const host = createAgentHarnessHostCapabilities({
          pluginId: "replay-fixed-model",
          attempt: { ...identity, workspaceDir, cwd, config, admittedRunContext },
        });
        const policy = projectEffectiveExecPolicy({
          base: { host: "gateway", mode: "full" },
          overrides: params.execOverrides,
          permissionPolicy: { mode: params.permissionMode ?? "read-only" },
        });
        const [tool] = host.capabilities.bindToolSurface([
          createExecTool({
            ...policy,
            ...identity,
            config,
            cwd: workspaceDir,
            allowBackground: false,
          }),
        ]);
        try {
          if (!tool) {
            throw new Error("Missing admitted exec");
          }
          marker = path.join(workspaceDir, "native-replay-effects");
          const result = await tool.execute("fixed-action", {
            command: "printf 'effect\n' >> native-replay-effects",
            workdir: workspaceDir,
            yieldMs: 10000,
          });
          effects.push(result.details);
          runIds.push(runId);
          return {
            ...nativeResult(text),
            meta: { durationMs: 0, terminalReply: { disposition: "visible", text } },
          } satisfies EmbeddedAgentRunResult;
        } finally {
          host.close();
        }
      }).catch((error: unknown) => {
        failed.reject(error);
        throw error;
      }),
    );
    await withNativePlugin(
      async (fixture) => {
        const { socket } = await connectNativeSession(fixture);
        let completed = createDeferredCore();
        const send = socket.send.bind(socket);
        vi.spyOn(socket, "send").mockImplementation((payload) => {
          send(payload);
          const event = JSON.parse(payload);
          if (
            event.type === "delegation.context.append" &&
            event.channel === "speakable" &&
            typeof event.delegation_item_id === "string"
          ) {
            completed.resolve();
          }
        });
        const settle = async () => {
          await Promise.race([completed.promise, failed.promise]);
          // Final append precedes the controller's finally; join its settlement turn.
          await nextEventLoopTurn();
        };
        socket.serverEvent(nativeDelegation("D1", "Carry out the action."));
        await settle();
        expect(admitted).toHaveBeenCalledTimes(1);
        completed = createDeferredCore();
        socket.serverEvent(nativeDelegation("D1", "Carry out the action."));
        // Admission is synchronous at this registered producer. If the original bug
        // starts a duplicate, join it rather than canceling it with the fresh request.
        if (admitted.mock.calls.length > 1) {
          await settle();
        }
        const afterReplay = await fs.readFile(marker, "utf8");
        completed = createDeferredCore();
        socket.serverEvent(nativeDelegation("D2", "Carry out the action."));
        await settle();
        expect({
          admissions: admitted.mock.calls.length,
          afterReplay,
          finalEffects: await fs.readFile(marker, "utf8"),
          uniqueRuns: new Set(runIds).size,
        }).toEqual({
          admissions: 2,
          afterReplay: "effect\n",
          finalEffects: "effect\neffect\n",
          uniqueRuns: 2,
        });
        for (const effect of effects) {
          expect(effect).toMatchObject({ status: "completed", exitCode: 0 });
        }
      },
      { model: "gpt-live-1-codex", nativeEffects: true, onConsult: admitted },
    );
  },
);
