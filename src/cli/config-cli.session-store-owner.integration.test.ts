import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const {
  registeredRuntimeLogs: logs,
  runRegisteredConfigCommand: invoke,
  withConfigFileHarness: withFile,
} = useConfigCliIntegrationHarness();

const read = (file: string) => fs.readFileSync(file, "utf8");
const readJson = (file: string) => JSON.parse(read(file));
const run = (...args: string[]) => invoke(["config", ...args]);
const set = (...args: string[]) => invoke(["config", "set", ...args]);
const withConfig = (raw: string, visit: Parameters<typeof withFile>[2]) =>
  withFile("config-cli-", raw, visit);
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
  it.each([
    { store: undefined, mode: "set" },
    { store: "stores/{agentId}/sessions.json", mode: "patch" },
  ])(
    "preserves the owner across no-op and unrelated $mode with store $store",
    async ({ store, mode }) => {
      const original = fleetConfig(store);
      const raw = JSON.stringify(original);
      await withConfig(raw, async ({ configPath, tempDir }) => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        await set("agents.defaults.bootstrapMaxChars", "30000");
        expect(logs.join("\n")).toContain("No change");
        expect(read(configPath)).toBe(raw);

        const patchPath = path.join(tempDir, "patch.json");
        fs.writeFileSync(
          patchPath,
          JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 30001 } } }),
        );
        await invoke(
          mode === "set"
            ? ["config", "set", "agents.defaults.bootstrapMaxChars", "30001"]
            : ["config", "patch", "--file", patchPath],
        );
        const after = readJson(configPath);
        expect(after.agents.defaults).toEqual({
          ...original.agents.defaults,
          bootstrapMaxChars: 30001,
        });
        expect(after.session?.store).toBe(store);
        await run("get", ownerPath);
        expect(logs.at(-1)?.trim()).toBe("discord-main");
        expect(warning.mock.calls.flat().join("\n")).not.toContain(`Cleared ${ownerPath}`);
      });
    },
  );

  it.each([
    { name: "fixed to default", before: "source.sqlite", after: undefined },
    {
      name: "template to different template",
      before: "old/{agentId}/sessions.json",
      after: "new/{agentId}/sessions.json",
    },
  ])("clears the copied owner with a warning on $name", async ({ before, after }) => {
    await withConfig("{}", async ({ configPath, tempDir }) => {
      const original = fleetConfig(before && path.join(tempDir, before));
      fs.writeFileSync(configPath, JSON.stringify(original));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const args = after
        ? ["config", "set", "session.store", path.join(tempDir, after)]
        : ["config", "unset", "session.store"];
      await invoke([...args, "--dry-run"]);
      expect(warning.mock.calls.flat().join("\n")).not.toContain(`Cleared ${ownerPath}`);
      await invoke(args);
      const saved = readJson(configPath);
      expect(saved.agents.defaults.sessionStore?.agentId).toBeUndefined();
      expect(saved.agents.defaults.authInheritance).toEqual(
        original.agents.defaults.authInheritance,
      );
      expect(saved.agents.defaults.systemAgent).toEqual(original.agents.defaults.systemAgent);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`Cleared ${ownerPath} because session.store changed`),
      );
    });
  });
});
