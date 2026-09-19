import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const { registeredRuntimeLogs, runRegisteredConfigCommand, withConfigFileHarness } =
  useConfigCliIntegrationHarness();
const ownerPath = "agents.defaults.sessionStore.agentId";

function fleetConfig(store?: string) {
  return {
    agents: {
      ownership: "explicit",
      defaults: {
        bootstrapMaxChars: 30000,
        sessionStore: { agentId: "discord-main" },
        authInheritance: { agentId: "discord-main" },
        systemAgent: { agentId: "discord-main" },
      },
      entries: {
        "discord-main": {},
        "anthropic-main": {},
        "local-helper": {},
        "xai-main": {},
      },
    },
    ...(store ? { session: { store } } : {}),
  };
}

describe("config CLI session store ownership", () => {
  it.each(
    [undefined, "stores/{agentId}/sessions.json", "stores/shared.sqlite"].flatMap((store) =>
      ["set", "patch"].map((mode) => ({ store, mode })),
    ),
  )(
    "preserves the owner across no-op and unrelated $mode with store $store",
    async ({ store, mode }) => {
      const original = fleetConfig(store);
      const raw = JSON.stringify(original);
      await withConfigFileHarness(
        "openclaw-config-session-owner-",
        raw,
        async ({ configPath, tempDir }) => {
          const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
          await runRegisteredConfigCommand([
            "config",
            "set",
            "agents.defaults.bootstrapMaxChars",
            "30000",
          ]);
          expect(registeredRuntimeLogs.join("\n")).toContain("No change");
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);

          const patchPath = path.join(tempDir, "patch.json");
          fs.writeFileSync(
            patchPath,
            JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 30001 } } }),
          );
          await runRegisteredConfigCommand(
            mode === "set"
              ? ["config", "set", "agents.defaults.bootstrapMaxChars", "30001"]
              : ["config", "patch", "--file", patchPath],
          );
          const after = JSON.parse(fs.readFileSync(configPath, "utf8"));
          expect(after.agents.defaults).toEqual({
            ...original.agents.defaults,
            bootstrapMaxChars: 30001,
          });
          expect(after.session?.store).toBe(store);
          await runRegisteredConfigCommand(["config", "get", ownerPath]);
          expect(registeredRuntimeLogs.at(-1)?.trim()).toBe("discord-main");
          expect(warning.mock.calls.flat().join("\n")).not.toContain(`Cleared ${ownerPath}`);
        },
      );
    },
  );

  it.each([
    { name: "default to fixed", before: undefined, after: "destination.sqlite" },
    { name: "fixed to default", before: "source.sqlite", after: undefined },
    { name: "fixed to different fixed", before: "source.sqlite", after: "destination.sqlite" },
    {
      name: "template to different template",
      before: "old/{agentId}/sessions.json",
      after: "new/{agentId}/sessions.json",
    },
  ])("clears the copied owner with a warning on $name", async ({ before, after }) => {
    await withConfigFileHarness(
      "openclaw-config-session-change-",
      "{}",
      async ({ configPath, tempDir }) => {
        const original = fleetConfig(before && path.join(tempDir, before));
        fs.writeFileSync(configPath, JSON.stringify(original));
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const args = after
          ? ["config", "set", "session.store", path.join(tempDir, after)]
          : ["config", "unset", "session.store"];
        await runRegisteredConfigCommand([...args, "--dry-run"]);
        expect(warning.mock.calls.flat().join("\n")).not.toContain(`Cleared ${ownerPath}`);
        await runRegisteredConfigCommand(args);
        const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
        expect(saved.agents.defaults.sessionStore?.agentId).toBeUndefined();
        expect(saved.agents.defaults.authInheritance).toEqual(
          original.agents.defaults.authInheritance,
        );
        expect(saved.agents.defaults.systemAgent).toEqual(original.agents.defaults.systemAgent);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(`Cleared ${ownerPath} because session.store changed`),
        );
      },
    );
  });
});
