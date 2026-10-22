import { appendFile, readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import { ensureConfiguredAcpBindingSession } from "../../acp/persistent-bindings.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { withDiscordNativeAdminFixture } from "./discord-native-owner.test-support.js";
import { configureNativeAcp, createNativeAcpRuntime } from "./native-acp-owner.test-support.js";

it.each([
  { commandName: "think", preparation: "initialize", label: "initialization" },
  { commandName: "think", preparation: "configure", label: "configuration" },
  { commandName: "think", preparation: "replace", label: "replacement" },
  { commandName: "new", preparation: "initialize", label: "recovery initialization" },
  { commandName: "status", preparation: "initialize", label: "read without initialization" },
  { commandName: "status", preparation: "replace", label: "read without replacement" },
  { commandName: "think", preparation: "revoke", label: "revocation during capability lookup" },
  { commandName: "think", preparation: "settle", label: "revocation during accepted control" },
] as const)("fences /$commandName ACP $label", async ({ commandName, preparation }) => {
  await withDiscordNativeAdminFixture(
    async ({ cfg, state, profile, publishConfig, run, dispatch, autocomplete }) => {
      const { backendId, binding, spec } = configureNativeAcp(cfg, state, "discord", publishConfig);
      const effectsPath = state.path("acp-effects.log");
      const effects = () => readFile(effectsPath, "utf8");
      const record = (effect: string) => appendFile(effectsPath, effect + "\n");
      const { runtime, preparing, finish, pause } = createNativeAcpRuntime(
        backendId,
        record,
        preparation === "revoke" ? "capability" : preparation === "settle" ? "control" : undefined,
        true,
      );
      managerTesting.resetAcpSessionManagerForTests();
      registerAcpRuntimeBackend({ id: backendId, runtime });
      const manager = getAcpSessionManager();
      try {
        if (preparation !== "initialize") {
          const existing = {
            ...spec,
            ...(preparation === "replace" ? { cwd: state.root } : { model: "fixture/previous" }),
            ...(preparation === "settle" ? { thinking: "off" } : {}),
          };
          expect(await ensureConfiguredAcpBindingSession({ cfg, spec: existing })).toMatchObject({
            ok: true,
          });
        }
        await writeFile(effectsPath, "");
        const target = { cfg, agentId: "main", sessionKey: binding.statefulTarget.sessionKey };
        const before = manager.resolveSession(target);
        const expectUnchanged = async () => {
          expect([await effects(), manager.resolveSession(target)]).toEqual(["", before]);
        };
        const expectDenied = (interaction: Awaited<ReturnType<typeof run>>) => {
          expect(interaction.followUp).toHaveBeenCalledWith({
            content: "You are not authorized to use this command.",
            ephemeral: true,
          });
          expect(dispatch).not.toHaveBeenCalled();
        };
        const command = { commandName, argument: commandName === "think" ? "high" : undefined };
        if (
          commandName === "think" &&
          ["initialize", "configure", "replace"].includes(preparation)
        ) {
          const completed = await autocomplete();
          expect(completed.respond).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ value: "high" })]),
          );
          await expectUnchanged();
          setUserProfileRole(profile.id, "member");
          const revoked = await autocomplete();
          expect(revoked.respond).toHaveBeenCalledWith([]);
          await expectUnchanged();
          setUserProfileRole(profile.id, "admin");
        }
        const denied = await run({ ...command, senderId: "100000000000000009" });
        if (commandName === "status") {
          let lastUpdatedAt: number | undefined;
          const expectStatus = async (interaction: Awaited<ReturnType<typeof run>>) => {
            expect(interaction.followUp).toHaveBeenCalledWith(
              expect.objectContaining({ content: expect.stringContaining("Session:") }),
            );
            expect(await effects()).toBe("");
            const after = manager.resolveSession(target);
            const previous = before.kind === "ready" && before.entry;
            const current = after.kind === "ready" && after.entry;
            if (!previous || !current) {
              expect(after).toEqual(before);
              return;
            }
            // Delivered /status replies are transcript activity, not ACP ownership changes.
            expect({
              ...after,
              entry: { ...current, updatedAt: previous.updatedAt },
            }).toEqual(before);
            expect(current.updatedAt).toBeGreaterThanOrEqual(lastUpdatedAt ?? previous.updatedAt);
            lastUpdatedAt = current.updatedAt;
          };
          await expectStatus(denied);
          await expectStatus(await run(command));
          expect(dispatch).not.toHaveBeenCalled();
          return;
        }
        expectDenied(denied);
        await expectUnchanged();
        pause();
        const allowedRun = run(command);
        if (preparation === "revoke" || preparation === "settle") {
          await preparing.promise;
          setUserProfileRole(profile.id, "member");
          finish.resolve();
          expectDenied(await allowedRun);
          const after = manager.resolveSession(target);
          if (preparation === "revoke") {
            await expectUnchanged();
          } else {
            expect(await effects()).toBe("configure:model\n");
            expect(after).toMatchObject({
              kind: "ready",
              meta: { runtimeOptions: { model: spec.model, thinking: "off" } },
            });
          }
          return;
        }
        await allowedRun;
        expect(dispatch).toHaveBeenCalledOnce();
        expect((await effects()).trim().split("\n")).toEqual(
          preparation === "configure"
            ? ["configure:model"]
            : preparation === "replace"
              ? ["close", "initialize"]
              : ["initialize"],
        );
        const after = manager.resolveSession(target);
        expect(after).toMatchObject({
          kind: "ready",
          meta: { runtimeOptions: { model: spec.model, cwd: state.workspaceDir } },
        });
      } finally {
        finish.resolve();
        await disposeAcpSessionManagerInstance(manager, "test complete");
        unregisterAcpRuntimeBackend(backendId);
        managerTesting.resetAcpSessionManagerForTests();
      }
    },
  );
});
