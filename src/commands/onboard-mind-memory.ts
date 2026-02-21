import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { getDockerStatus } from "../infra/docker.js";
import { ensureGraphitiDocker, installDocker } from "../plugins/mind-memory/docker.js";

export async function setupMindMemory(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Mind Memory adds a long-term 'autobiography' to your agent.",
      "It uses Graphiti and FalkorDB to remember facts and resonances.",
      "Requires Docker to be installed and running.",
    ].join("\n"),
    "Mind Memory",
  );

  const enabled = await prompter.confirm({
    message: "Enable Mind Memory (Long-term autobiography)?",
    initialValue: true,
  });

  if (!enabled) {
    return cfg;
  }

  let spin = prompter.progress("Checking Docker installation...");
  let dockerOk = false;

  try {
    dockerOk = await installDocker();

    if (!dockerOk) {
      spin.stop("Automated Docker installation failed.");

      await prompter.note(
        [
          "The automated installer failed (likely due to permissions).",
          "Please install Docker Desktop manually:",
          "👉 https://www.docker.com/products/docker-desktop",
          "",
          "Ensure Docker Desktop is RUNNING before continuing.",
          "(You can also skip this for now and run `moltbot mind-memory setup` later via CLI)",
        ].join("\n"),
        "Manual Installation Required",
      );

      const manualConfirm = await prompter.confirm({
        message: "Have you installed and started Docker manually?",
        initialValue: true,
      });

      if (manualConfirm) {
        spin = prompter.progress("Verifying manual installation...");
        const status = await getDockerStatus();
        if (status.running) {
          dockerOk = true;
          spin.stop("Docker detected!");
        } else {
          spin.stop("Could not detect running Docker daemon.");
        }
      }
    }

    if (!dockerOk) {
      // User opted out or manual check failed
      return cfg;
    }

    spin.stop("Docker available.");

    spin = prompter.progress(
      "Starting Mind Memory infrastructure (this may take a while to download images)...",
    );

    // Resolve plugin directory (hacky but effective since we're in src/commands)
    const currentFile = fileURLToPath(import.meta.url);
    const srcDir = path.dirname(path.dirname(currentFile));
    const pluginDir = path.join(srcDir, "plugins", "mind-memory");

    const started = await ensureGraphitiDocker(pluginDir);
    if (!started) {
      spin.stop("Failed to start Graphiti container (check logs).");
      // Keep it enabled? Safe to disable to avoid runtime errors if container failed.
      // But user config intent was enabled.
      // Let's return configured as enabled but warn.
      return cfg;
    }
    spin.stop("Mind Memory infrastructure is ready (Docker).");
  } catch (e: unknown) {
    try {
      const message = e instanceof Error ? e.message : String(e);
      spin.stop(`Mind Memory setup failed: ${message}`);
    } catch {}
    return cfg;
  }

  // Update config to enable the plugin
  type PluginsConfig = {
    slots?: Record<string, string>;
    entries?: Record<string, { enabled?: boolean; config?: unknown }>;
  };
  const next: OpenClawConfig = {
    ...cfg,
    plugins: {
      ...(cfg.plugins as PluginsConfig),
      slots: {
        ...(cfg.plugins as PluginsConfig)?.slots,
        memory: "mind-memory",
      },
      entries: {
        ...(cfg.plugins as PluginsConfig)?.entries,
        "mind-memory": {
          enabled: true,
          config: {
            graphiti: { enabled: true, autoStart: true },
            narrative: { enabled: true, autoBootstrapHistory: false },
          },
        },
      },
    },
  };

  return next;
}
