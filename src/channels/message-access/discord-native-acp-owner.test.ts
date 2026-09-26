import { appendFile, readFile, writeFile } from "node:fs/promises";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it } from "vitest";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import { ensureConfiguredAcpBindingSession } from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { resolveConfiguredBinding } from "../plugins/configured-binding-registry.js";
import { withDiscordNativeAdminFixture } from "./discord-native-owner.test-support.js";

it.each([
  { commandName: "think", preparation: "initialize", label: "initialization" },
  { commandName: "think", preparation: "configure", label: "configuration" },
  { commandName: "think", preparation: "replace", label: "replacement" },
  { commandName: "new", preparation: "initialize", label: "recovery initialization" },
  { commandName: "status", preparation: "initialize", label: "read without initialization" },
  { commandName: "status", preparation: "configure", label: "read without configuration" },
  { commandName: "status", preparation: "replace", label: "read without replacement" },
  { commandName: "think", preparation: "revoke", label: "revocation during capability lookup" },
  { commandName: "think", preparation: "settle", label: "revocation during accepted control" },
] as const)("fences /$commandName ACP $label", async ({ commandName, preparation }) => {
  await withDiscordNativeAdminFixture(
    async ({ cfg, state, profile, publishConfig, run, dispatch, autocomplete }) => {
      const backendId = "discord-owner-proof";
      cfg.acp = { enabled: true, backend: backendId, allowedAgents: ["main"] };
      cfg.session = { store: state.path("native-acp-sessions.json") };
      cfg.agents = {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" }, thinkingDefault: "high" },
        entries: { main: { workspace: state.workspaceDir, model: "fixture/current" } },
      };
      cfg.bindings = [
        {
          type: "acp",
          agentId: "main",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "234567890123456789" },
          },
          acp: { backend: backendId, cwd: state.workspaceDir, mode: "persistent" },
        },
      ];
      publishConfig();
      const binding = resolveConfiguredBinding({
        cfg,
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "234567890123456789",
        },
      });
      const spec = binding && resolveConfiguredAcpBindingSpecFromRecord(binding.record);
      if (!binding || !spec) {
        throw new Error("Expected the configured native-command ACP binding");
      }
      const effectsPath = state.path("acp-effects.log");
      const acceptedOptions = new Map<string, string>();
      const readinessAwaited = createDeferredCore();
      const releaseReadiness = createDeferredCore();
      let pauseReadiness = false;
      const runtime: AcpRuntime = {
        ownerAwareSessions: 1,
        async ensureSession(input) {
          await appendFile(effectsPath, "initialize\n");
          acceptedOptions.clear();
          if (input.model) {
            acceptedOptions.set("model", input.model);
          }
          if (input.thinking) {
            acceptedOptions.set("thinking", input.thinking);
          }
          return {
            agentId: input.agentId,
            sessionKey: input.sessionKey,
            backend: backendId,
            runtimeSessionName: input.sessionKey,
            backendSessionId: `runtime:${input.sessionKey}`,
            cwd: input.cwd,
          };
        },
        async getCapabilities() {
          if (pauseReadiness && preparation === "revoke") {
            readinessAwaited.resolve();
            await releaseReadiness.promise;
          }
          return { controls: ["session/set_config_option"] };
        },
        async setConfigOption({ key, value }) {
          await appendFile(effectsPath, `configure:${key}\n`);
          acceptedOptions.set(key, value);
          if (pauseReadiness && preparation === "settle" && key === "model") {
            readinessAwaited.resolve();
            await releaseReadiness.promise;
          }
          return {
            configOptions: [...acceptedOptions].map(([id, currentValue]) => ({ id, currentValue })),
          };
        },
        async close() {
          await appendFile(effectsPath, "close\n");
        },
        async cancel() {},
        runTurn() {
          throw new Error("This fixture must not start a provider turn");
        },
      };
      managerTesting.resetAcpSessionManagerForTests();
      registerAcpRuntimeBackend({ id: backendId, runtime });
      const manager = getAcpSessionManager();
      try {
        if (preparation !== "initialize") {
          expect(
            await ensureConfiguredAcpBindingSession({
              cfg,
              spec: {
                ...spec,
                ...(preparation === "replace"
                  ? { cwd: state.root }
                  : { model: "fixture/previous" }),
                ...(preparation === "settle" ? { thinking: "off" } : {}),
              },
            }),
          ).toMatchObject({ ok: true });
        }
        await writeFile(effectsPath, "");
        const target = { cfg, agentId: "main", sessionKey: binding.statefulTarget.sessionKey };
        const before = manager.resolveSession(target);
        if (
          commandName === "think" &&
          ["initialize", "configure", "replace"].includes(preparation)
        ) {
          const completed = await autocomplete();
          expect(completed.respond).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ value: "high" })]),
          );
          expect(await readFile(effectsPath, "utf8")).toBe("");
          expect(manager.resolveSession(target)).toEqual(before);
          setUserProfileRole(profile.id, "member");
          const revoked = await autocomplete();
          expect(revoked.respond).toHaveBeenCalledWith([]);
          expect(await readFile(effectsPath, "utf8")).toBe("");
          expect(manager.resolveSession(target)).toEqual(before);
          setUserProfileRole(profile.id, "admin");
        }
        const denied = await run({
          senderId: "100000000000000009",
          commandName,
          argument: commandName === "think" ? "high" : undefined,
        });
        if (commandName === "status") {
          expect(denied.followUp).toHaveBeenCalledWith(
            expect.objectContaining({
              content: expect.stringContaining("Session:"),
            }),
          );
          expect(await readFile(effectsPath, "utf8")).toBe("");
          expect(manager.resolveSession(target)).toEqual(before);
          const ownerStatus = await run({ commandName });
          expect(ownerStatus.followUp).toHaveBeenCalledWith(
            expect.objectContaining({
              content: expect.stringContaining("Session:"),
            }),
          );
          expect(await readFile(effectsPath, "utf8")).toBe("");
          expect(manager.resolveSession(target)).toEqual(before);
          expect(dispatch).not.toHaveBeenCalled();
          return;
        }
        expect(denied.followUp).toHaveBeenCalledWith({
          content: "You are not authorized to use this command.",
          ephemeral: true,
        });
        expect(await readFile(effectsPath, "utf8")).toBe("");
        expect(manager.resolveSession(target)).toEqual(before);
        expect(dispatch).not.toHaveBeenCalled();

        pauseReadiness = true;
        const allowedRun = run({
          commandName,
          argument: commandName === "think" ? "high" : undefined,
        });
        if (preparation === "revoke" || preparation === "settle") {
          await readinessAwaited.promise;
          setUserProfileRole(profile.id, "member");
          releaseReadiness.resolve();
          const rejected = await allowedRun;
          expect(rejected.followUp).toHaveBeenCalledWith({
            content: "You are not authorized to use this command.",
            ephemeral: true,
          });
          expect(dispatch).not.toHaveBeenCalled();
          const after = manager.resolveSession(target);
          if (preparation === "revoke") {
            expect(await readFile(effectsPath, "utf8")).toBe("");
            expect(after).toEqual(before);
          } else {
            expect(await readFile(effectsPath, "utf8")).toBe("configure:model\n");
            expect(after.kind).toBe("ready");
            if (after.kind === "ready") {
              expect(after.meta.runtimeOptions).toMatchObject({
                model: spec.model,
                thinking: "off",
              });
            }
          }
          return;
        }
        await allowedRun;
        expect(dispatch).toHaveBeenCalledOnce();
        const effects = (await readFile(effectsPath, "utf8")).trim().split("\n");
        expect(effects).toEqual(
          preparation === "configure"
            ? ["configure:model"]
            : preparation === "replace"
              ? ["close", "initialize"]
              : ["initialize"],
        );
        const after = manager.resolveSession(target);
        expect(after.kind).toBe("ready");
        if (after.kind === "ready") {
          expect(after.meta.runtimeOptions).toMatchObject({
            model: spec.model,
            cwd: state.workspaceDir,
          });
        }
      } finally {
        releaseReadiness.resolve();
        await disposeAcpSessionManagerInstance(manager, "test complete");
        unregisterAcpRuntimeBackend(backendId);
        managerTesting.resetAcpSessionManagerForTests();
      }
    },
  );
});
