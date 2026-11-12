import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { pinConfigDir } from "../utils.js";
import { writeHookFixture } from "./hook-fixture.test-support.js";
import { readHookInstalls } from "./installs.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  setInternalHooksEnabled,
  triggerInternalHook,
} from "./internal-hooks.js";
import { prepareInternalHooks } from "./loader.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

function writeHook(hookDir: string, name: string): void {
  writeHookFixture(
    hookDir,
    `---\nname: ${name}\ndescription: "Test hook"\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n`,
    `export default async function(event) { event.messages.push(${JSON.stringify(name)}); }\n`,
    "handler.js",
  );
}

describe.each([false, true])("hooks install (link=%s)", (link) => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "hooks-install", layout: "split" });
    pinConfigDir();
    clearInternalHooks();
    await state.writeConfig({
      agents: { defaults: { workspace: state.workspaceDir } },
      plugins: { enabled: false },
    });
  });

  afterEach(async () => {
    try {
      (
        await prepareInternalHooks({ hooks: { internal: { enabled: false } } }, state.workspaceDir)
      ).commit();
      clearInternalHooks();
      setInternalHooksEnabled(true);
    } finally {
      await state.cleanup();
      vi.unstubAllEnvs();
      pinConfigDir();
    }
  });

  it.each([".", "./hooks/hello-hook", "./hello-hook"])(
    "discovers and triggers only installed hooks from %s",
    async (hookPath) => {
      const hookPackId = hookPath === "." ? "hello-hook" : "hello-hooks";
      const sourceDir = state.path("sources", "hook-pack");
      writeHook(path.resolve(sourceDir, hookPath), "hello-hook");
      writeHook(state.path("sources", "adjacent-hook"), "adjacent-hook");
      if (hookPath !== ".") {
        await fs.writeFile(
          path.join(sourceDir, "package.json"),
          JSON.stringify({
            name: "@acme/hello-hooks",
            version: "0.0.0",
            openclaw: { hooks: [hookPath] },
          }),
          "utf-8",
        );
        // A package manifest selects its hooks; neither root nor nested siblings are implicit hooks.
        writeHook(path.join(sourceDir, "unlisted-root"), "unlisted-root");
        writeHook(path.join(sourceDir, "hooks", "unlisted-nested"), "unlisted-nested");
      }

      await runPluginInstallCommand({
        raw: sourceDir,
        opts: { force: true, acceptCapabilities: true, link },
        allowInstallPolicyWarningPrompt: false,
      });

      const { config } = await readConfigFileSnapshot();
      expect(config.hooks?.internal?.entries?.["hello-hook"]?.enabled).toBe(true);
      expect(config.hooks?.internal?.load?.extraDirs ?? []).toEqual(link ? [sourceDir] : []);
      expect(readHookInstalls()[hookPackId]?.installPath).toBe(
        link ? sourceDir : state.statePath("hooks", hookPackId),
      );
      vi.stubEnv("OPENCLAW_BUNDLED_HOOKS_DIR", state.path("bundled-none"));
      const discovered = loadWorkspaceHookEntries(state.workspaceDir, { config });
      const prepared = await prepareInternalHooks(config, state.workspaceDir);
      prepared.commit();
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(discovered.map((entry) => entry.hook.name)).toEqual(["hello-hook"]);
      expect(event.messages).toEqual(["hello-hook"]);
    },
  );
});
