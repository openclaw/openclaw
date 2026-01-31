import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  resolveSandboxScope,
} from "../agents/sandbox.js";
import { execDocker } from "../agents/sandbox/docker.js";
import type { OpenClawConfig } from "../config/config.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type SandboxScriptInfo = {
  scriptPath: string;
  cwd: string;
};

function resolveSandboxScript(scriptRel: string): SandboxScriptInfo | null {
  const candidates = new Set<string>();
  candidates.add(process.cwd());
  const argv1 = process.argv[1];
  if (argv1) {
    const normalized = path.resolve(argv1);
    candidates.add(path.resolve(path.dirname(normalized), ".."));
    candidates.add(path.resolve(path.dirname(normalized)));
  }

  for (const root of candidates) {
    const scriptPath = path.join(root, scriptRel);
    if (fs.existsSync(scriptPath)) {
      return { scriptPath, cwd: root };
    }
  }

  return null;
}

async function runSandboxScript(scriptRel: string, runtime: RuntimeEnv): Promise<boolean> {
  const script = resolveSandboxScript(scriptRel);
  if (!script) {
    note(`Unable to locate ${scriptRel}. Run it from the repo root.`, "Sandbox");
    return false;
  }

  runtime.log(`Running ${scriptRel}...`);
  const result = await runCommandWithTimeout(["bash", script.scriptPath], {
    timeoutMs: 20 * 60 * 1000,
    cwd: script.cwd,
  });
  if (result.code !== 0) {
    runtime.error(
      `Failed running ${scriptRel}: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
    return false;
  }

  runtime.log(`Completed ${scriptRel}.`);
  return true;
}

async function buildDefaultSandboxImage(runtime: RuntimeEnv): Promise<boolean> {
  runtime.log("Building default sandbox image (docker pull + tag)...");
  try {
    await execDocker(["pull", "debian:bookworm-slim"]);
    await execDocker(["tag", "debian:bookworm-slim", DEFAULT_SANDBOX_IMAGE]);
    runtime.log(`Built ${DEFAULT_SANDBOX_IMAGE}.`);
    return true;
  } catch (error: any) {
    runtime.error(`Failed to build sandbox image: ${error?.message || "unknown error"}`);
    return false;
  }
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await runExec("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await runExec("docker", ["image", "inspect", image], { timeoutMs: 5_000 });
    return true;
  } catch (error: any) {
    const stderr = error?.stderr || error?.message || "";
    if (String(stderr).includes("No such image")) {
      return false;
    }
    throw error;
  }
}

function resolveSandboxDockerImage(cfg: OpenClawConfig): string {
  const image = cfg.agents?.defaults?.sandbox?.docker?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_IMAGE;
}

function resolveSandboxBrowserImage(cfg: OpenClawConfig): string {
  const image = cfg.agents?.defaults?.sandbox?.browser?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_BROWSER_IMAGE;
}

function updateSandboxDockerImage(cfg: OpenClawConfig, image: string): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        sandbox: {
          ...cfg.agents?.defaults?.sandbox,
          docker: {
            ...cfg.agents?.defaults?.sandbox?.docker,
            image,
          },
        },
      },
    },
  };
}

function updateSandboxBrowserImage(cfg: OpenClawConfig, image: string): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        sandbox: {
          ...cfg.agents?.defaults?.sandbox,
          browser: {
            ...cfg.agents?.defaults?.sandbox?.browser,
            image,
          },
        },
      },
    },
  };
}

type SandboxImageCheck = {
  kind: string;
  image: string;
  buildScript?: string;
  inlineBuild?: () => Promise<boolean>;
  updateConfig: (image: string) => void;
};

async function handleMissingSandboxImage(
  params: SandboxImageCheck,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const exists = await dockerImageExists(params.image);
  if (exists) {
    return;
  }

  const canBuild = params.inlineBuild || params.buildScript;
  const buildHint = canBuild
    ? params.buildScript
      ? `Build it with ${params.buildScript}.`
      : "Build it now."
    : "Build or pull it first.";
  note(`Sandbox ${params.kind} image missing: ${params.image}. ${buildHint}`, "Sandbox");

  let built = false;
  if (canBuild) {
    const build = await prompter.confirmSkipInNonInteractive({
      message: `Build ${params.kind} sandbox image now?`,
      initialValue: true,
    });
    if (build) {
      if (params.inlineBuild) {
        built = await params.inlineBuild();
      } else if (params.buildScript) {
        built = await runSandboxScript(params.buildScript, runtime);
      }
    }
  }

  if (built) {
    return;
  }
}

export async function maybeRepairSandboxImages(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const sandbox = cfg.agents?.defaults?.sandbox;
  const mode = sandbox?.mode ?? "off";
  if (!sandbox || mode === "off") {
    return cfg;
  }

  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    note("Docker not available; skipping sandbox image checks.", "Sandbox");
    return cfg;
  }

  let next = cfg;
  const changes: string[] = [];

  const dockerImage = resolveSandboxDockerImage(cfg);
  await handleMissingSandboxImage(
    {
      kind: "base",
      image: dockerImage,
      // For DEFAULT_SANDBOX_IMAGE, use inline docker pull/tag (works without repo scripts).
      // For other default images, fall back to the repo script if available.
      inlineBuild:
        dockerImage === DEFAULT_SANDBOX_IMAGE ? () => buildDefaultSandboxImage(runtime) : undefined,
      buildScript:
        dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
          ? "scripts/sandbox-common-setup.sh"
          : undefined,
      updateConfig: (image) => {
        next = updateSandboxDockerImage(next, image);
        changes.push(`Updated agents.defaults.sandbox.docker.image → ${image}`);
      },
    },
    runtime,
    prompter,
  );

  if (sandbox.browser?.enabled) {
    await handleMissingSandboxImage(
      {
        kind: "browser",
        image: resolveSandboxBrowserImage(cfg),
        buildScript: "scripts/sandbox-browser-setup.sh",
        updateConfig: (image) => {
          next = updateSandboxBrowserImage(next, image);
          changes.push(`Updated agents.defaults.sandbox.browser.image → ${image}`);
        },
      },
      runtime,
      prompter,
    );
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }

  return next;
}

export function noteSandboxScopeWarnings(cfg: OpenClawConfig) {
  const globalSandbox = cfg.agents?.defaults?.sandbox;
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const warnings: string[] = [];

  for (const agent of agents) {
    const agentId = agent.id;
    const agentSandbox = agent.sandbox;
    if (!agentSandbox) {
      continue;
    }

    const scope = resolveSandboxScope({
      scope: agentSandbox.scope ?? globalSandbox?.scope,
      perSession: agentSandbox.perSession ?? globalSandbox?.perSession,
    });

    if (scope !== "shared") {
      continue;
    }

    const overrides: string[] = [];
    if (agentSandbox.docker && Object.keys(agentSandbox.docker).length > 0) {
      overrides.push("docker");
    }
    if (agentSandbox.browser && Object.keys(agentSandbox.browser).length > 0) {
      overrides.push("browser");
    }
    if (agentSandbox.prune && Object.keys(agentSandbox.prune).length > 0) {
      overrides.push("prune");
    }

    if (overrides.length === 0) {
      continue;
    }

    warnings.push(
      [
        `- agents.list (id "${agentId}") sandbox ${overrides.join("/")} overrides ignored.`,
        `  scope resolves to "shared".`,
      ].join("\n"),
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Sandbox");
  }
}
