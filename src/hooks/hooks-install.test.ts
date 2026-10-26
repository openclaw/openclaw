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

describe.each([
  { mode: "copied", link: false },
  { mode: "linked", link: true },
])("hooks install ($mode)", ({ link }) => {
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
      const disabled = await prepareInternalHooks(
        { hooks: { internal: { enabled: false } } },
        state.workspaceDir,
      );
      disabled.commit();
      clearInternalHooks();
      setInternalHooksEnabled(true);
    } finally {
      await state.cleanup();
      vi.unstubAllEnvs();
      pinConfigDir();
    }
  });

  it.each([
    { layout: "single hook", hookPath: ".", hookPackId: "hello-hook" },
    { layout: "conventional pack", hookPath: "./hooks/hello-hook", hookPackId: "hello-hooks" },
    { layout: "direct-child pack", hookPath: "./hello-hook", hookPackId: "hello-hooks" },
  ])(
    "discovers and triggers only installed hooks from a $layout",
    async ({ hookPath, hookPackId }) => {
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

      const installed = await readConfigFileSnapshot();
      expect(installed.valid).toBe(true);
      expect(installed.config.hooks?.internal).toMatchObject({
        enabled: true,
        entries: { "hello-hook": { enabled: true } },
      });
      expect(installed.config.hooks?.internal?.load?.extraDirs ?? []).toEqual(
        link ? [sourceDir] : [],
      );
      const installPath = link ? sourceDir : state.statePath("hooks", hookPackId);
      expect(readHookInstalls()).toEqual({
        [hookPackId]: expect.objectContaining({
          source: "path",
          sourcePath: sourceDir,
          installPath,
          hooks: ["hello-hook"],
        }),
      });
      vi.stubEnv("OPENCLAW_BUNDLED_HOOKS_DIR", state.path("bundled-none"));
      const discovered = loadWorkspaceHookEntries(state.workspaceDir, {
        config: installed.config,
      });
      const prepared = await prepareInternalHooks(installed.config, state.workspaceDir);
      prepared.commit();
      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);
      expect(discovered.map((entry) => entry.hook.name)).toEqual(["hello-hook"]);
      expect(prepared.loadedCount).toBe(1);
      expect(event.messages).toEqual(["hello-hook"]);
    },
  );
});
