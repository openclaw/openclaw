import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveCliName } from "../cli/cli-name.js";
import { completionCacheExists, installCompletion, isCompletionInstalled, resolveCompletionCachePath, resolveShellFromEnv, usesSlowDynamicCompletion, } from "../cli/completion-runtime.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { note } from "../terminal/note.js";
const COMPLETION_CACHE_WRITE_TIMEOUT_MS = 30_000;
/** Generate the completion cache by spawning the CLI. */
async function generateCompletionCache() {
    const root = await resolveOpenClawPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
    });
    if (!root) {
        return false;
    }
    const binPath = path.join(root, "openclaw.mjs");
    const result = spawnSync(process.execPath, [binPath, "completion", "--write-state"], {
        cwd: root,
        env: process.env,
        encoding: "utf-8",
        timeout: COMPLETION_CACHE_WRITE_TIMEOUT_MS,
    });
    return result.status === 0;
}
/** Check the status of shell completion for the current shell. */
export async function checkShellCompletionStatus(binName = "openclaw") {
    const shell = resolveShellFromEnv();
    const profileInstalled = await isCompletionInstalled(shell, binName);
    const cacheExists = await completionCacheExists(shell, binName);
    const cachePath = resolveCompletionCachePath(shell, binName);
    const usesSlowPattern = await usesSlowDynamicCompletion(shell, binName);
    return {
        shell,
        profileInstalled,
        cacheExists,
        cachePath,
        usesSlowPattern,
    };
}
/**
 * Doctor check for shell completion.
 * - If profile uses slow dynamic pattern: upgrade to cached version
 * - If profile has completion but no cache: auto-generate cache and upgrade profile
 * - If no completion at all: prompt to install (with user confirmation)
 */
export async function doctorShellCompletion(runtime, prompter, options = {}) {
    const cliName = resolveCliName();
    const status = await checkShellCompletionStatus(cliName);
    // Profile uses slow dynamic pattern - upgrade to cached version
    if (status.usesSlowPattern) {
        note(`Your ${status.shell} profile uses slow dynamic completion (source <(...)).\nUpgrading to cached completion for faster shell startup...`, "Shell completion");
        // Ensure cache exists first
        if (!status.cacheExists) {
            const generated = await generateCompletionCache();
            if (!generated) {
                note(`Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`, "Shell completion");
                return;
            }
        }
        // Upgrade profile to use cached file
        await installCompletion(status.shell, true, cliName);
        note(`Shell completion upgraded. Restart your shell or run: source ~/.${status.shell === "zsh" ? "zshrc" : status.shell === "bash" ? "bashrc" : "config/fish/config.fish"}`, "Shell completion");
        return;
    }
    // Profile has completion but no cache - auto-fix
    if (status.profileInstalled && !status.cacheExists) {
        note(`Shell completion is configured in your ${status.shell} profile but the cache is missing.\nRegenerating cache...`, "Shell completion");
        const generated = await generateCompletionCache();
        if (generated) {
            note(`Completion cache regenerated at ${status.cachePath}`, "Shell completion");
        }
        else {
            note(`Failed to regenerate completion cache. Run \`${cliName} completion --write-state\` manually.`, "Shell completion");
        }
        return;
    }
    // No completion at all - prompt to install
    if (!status.profileInstalled) {
        if (options.nonInteractive) {
            // In non-interactive mode, just note that completion is not installed
            return;
        }
        const shouldInstall = await prompter.confirm({
            message: `Enable ${status.shell} shell completion for ${cliName}?`,
            initialValue: true,
        });
        if (shouldInstall) {
            // First generate the cache
            const generated = await generateCompletionCache();
            if (!generated) {
                note(`Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`, "Shell completion");
                return;
            }
            // Then install to profile
            await installCompletion(status.shell, true, cliName);
            note(`Shell completion installed. Restart your shell or run: source ~/.${status.shell === "zsh" ? "zshrc" : status.shell === "bash" ? "bashrc" : "config/fish/config.fish"}`, "Shell completion");
        }
    }
}
/**
 * Ensure completion cache exists. Used during setup/update to fix
 * cases where profile has completion but no cache.
 * This is a silent fix - no prompts.
 */
export async function ensureCompletionCacheExists(binName = "openclaw") {
    const shell = resolveShellFromEnv();
    const cacheExists = await completionCacheExists(shell, binName);
    if (cacheExists) {
        return true;
    }
    return generateCompletionCache();
}
