import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type SetupGemmaCommandOpts = {
  advanced?: boolean;
  noContainer?: boolean;
};

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_MAX_ATTEMPTS = 60;

async function probeGatewayHealth(port: number): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${String(port)}/healthz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return false;
    }
    const body = await res.text();
    return body.includes("ok");
  } catch {
    return false;
  }
}

async function waitForGatewayReady(port: number): Promise<boolean> {
  for (let i = 0; i < HEALTH_POLL_MAX_ATTEMPTS; i++) {
    if (await probeGatewayHealth(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function killProcessesOnPort(port: number): void {
  try {
    const pids = execSync(`lsof -ti :${port}`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: "pipe",
    }).trim();
    if (pids) {
      for (const pid of pids.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          // Already gone.
        }
      }
      // Give processes a moment to exit.
      execSync("sleep 1", { stdio: "pipe" });
      // Force kill any that survived.
      for (const pid of pids.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  } catch {
    // No processes on port, or lsof not available.
  }
}

function resolveCliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../dist/entry.js"),
    path.resolve(here, "../gemmaclaw.mjs"),
    path.resolve(here, "../openclaw.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return process.argv[1] ?? candidates[0];
}

function spawnGatewayDetached(port: number): ChildProcess {
  const entryPath = resolveCliEntryPath();
  const child = spawn(process.execPath, [entryPath, "gateway", "run", "--port", String(port)], {
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  child.unref();
  return child;
}

function isDockerInstalled(): boolean {
  try {
    execSync("docker --version", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function isDockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

type PrereqCheck = { name: string; ok: boolean; help?: string };

function checkPrerequisites(noContainer: boolean): PrereqCheck[] {
  const checks: PrereqCheck[] = [];

  const nodeVersion = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    name: "Node.js 22+",
    ok: nodeVersion >= 22,
    help:
      nodeVersion < 22
        ? `Found Node.js ${process.versions.node}. Install Node 22+:\n` +
          `  macOS:   brew install node@22\n` +
          `  Linux:   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs\n` +
          `  nvm:     nvm install 22 && nvm use 22`
        : undefined,
  });

  if (!noContainer) {
    const installed = isDockerInstalled();
    const running = installed && isDockerRunning();

    if (!installed) {
      checks.push({
        name: "Docker",
        ok: false,
        help:
          `Docker is not installed. Install it to run the gateway in an isolated container:\n` +
          `  macOS:   brew install --cask docker   (then open Docker.app)\n` +
          `  Linux:   curl -fsSL https://get.docker.com | sh\n` +
          `  Windows: https://docs.docker.com/desktop/install/windows-install/\n` +
          `\n` +
          `  Or skip Docker and run directly on the host:\n` +
          `    gemmaclaw setup --no-container`,
      });
    } else if (!running) {
      checks.push({
        name: "Docker daemon",
        ok: false,
        help:
          `Docker is installed but the daemon is not running.\n` +
          `  macOS:   Open Docker Desktop (or: open -a Docker)\n` +
          `  Linux:   sudo systemctl start docker\n` +
          `\n` +
          `  Or skip Docker and run directly on the host:\n` +
          `    gemmaclaw setup --no-container`,
      });
    } else {
      checks.push({ name: "Docker", ok: true });
    }
  }

  return checks;
}

export async function setupGemmaCommand(
  opts: SetupGemmaCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Lazy-load to keep CLI startup fast.
  const { detectHardware, detectSystemTools, formatHardwareInfo } =
    await import("../gemmaclaw/provision/hardware.js");
  const { selectQuickProfile, runAdvancedWizard, createStdioWizardIO, formatModelSize } =
    await import("../gemmaclaw/provision/setup-wizard.js");
  const { provision, verifyCompletion } = await import("../gemmaclaw/provision/provision.js");
  const { DEFAULT_GATEWAY_PORT } = await import("../config/paths.js");

  runtime.log("");
  runtime.log("Checking prerequisites...");
  const prereqs = checkPrerequisites(Boolean(opts.noContainer));
  const failedPrereqs = prereqs.filter((p) => !p.ok);

  for (const p of prereqs) {
    runtime.log(`  ${p.ok ? "+" : "x"} ${p.name}`);
  }

  if (failedPrereqs.length > 0) {
    runtime.log("");
    for (const p of failedPrereqs) {
      runtime.error(`Missing: ${p.name}`);
      if (p.help) {
        for (const line of p.help.split("\n")) {
          runtime.error(`  ${line}`);
        }
      }
      runtime.error("");
    }
    runtime.exit(1);
  }

  runtime.log("");
  runtime.log("Detecting hardware...");

  const hw = detectHardware();
  const tools = detectSystemTools();

  for (const line of formatHardwareInfo(hw)) {
    runtime.log(line);
  }

  let profile;

  if (opts.advanced) {
    // Advanced: interactive prompts.
    const io = createStdioWizardIO();
    try {
      profile = await runAdvancedWizard(io, hw, tools);
    } finally {
      io.close();
    }
  } else {
    // Quick: auto-select best backend and model for this hardware.
    profile = selectQuickProfile(hw, tools);
    const displayName = profile.modelDisplayName ?? profile.model ?? "default model";
    const dlSize = formatModelSize(profile.modelDownloadBytes);
    runtime.log("");
    runtime.log(`Recommended: ${displayName} (${dlSize} download)`);
    runtime.log(`  ${profile.reason}`);
  }

  runtime.log("");
  runtime.log(`Provisioning ${profile.backend} on port ${profile.port}...`);

  const progress = (msg: string) => runtime.log(msg);

  try {
    const result = await provision({
      backend: profile.backend,
      model: profile.model,
      port: profile.port,
      progress,
    });

    // Smoke test.
    runtime.log("");
    runtime.log("Running smoke test...");
    const verification = await verifyCompletion(result.handle.apiBaseUrl, result.modelId);

    if (verification.ok) {
      runtime.log(`Smoke test passed. Response: "${verification.content}"`);

      // Write gateway config pointing to the local Ollama provider.
      runtime.log("");
      runtime.log("Writing gateway configuration...");
      const { mutateConfigFile } = await import("../config/mutate.js");
      const ollamaModel = result.modelId;
      const ollamaBaseUrl = `${result.handle.apiBaseUrl}/v1`;
      const enableSandbox = !opts.noContainer && isDockerRunning();
      await mutateConfigFile({
        mutate: (draft) => {
          draft.gateway ??= {};
          draft.gateway.mode = "local";
          draft.gateway.auth ??= {};
          draft.gateway.auth.mode = "none";

          draft.models ??= {};
          draft.models.providers ??= {};
          draft.models.providers.ollama = {
            baseUrl: ollamaBaseUrl,
            api: "ollama",
            models: [
              {
                id: ollamaModel,
                name: ollamaModel,
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 262_144,
                maxTokens: 8_192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          };

          draft.agents ??= {};
          draft.agents.defaults ??= {};
          draft.agents.defaults.model = `ollama/${ollamaModel}`;

          // Enable full tool access with sandbox isolation.
          // The gateway runs on the host, but agent tool execution (shell, file
          // ops, browser) runs inside Docker sandbox containers.
          draft.tools ??= {};
          draft.tools.exec ??= {};
          (draft.tools.exec as Record<string, unknown>).security = "full";
          (draft.tools.exec as Record<string, unknown>).ask = "off";

          if (enableSandbox) {
            draft.agents.defaults.sandbox = {
              mode: "all",
              backend: "docker",
              scope: "session",
              workspaceAccess: "rw",
            };
          }
        },
      });
      runtime.log(`  Provider: ollama (${ollamaBaseUrl})`);
      runtime.log(`  Model: ollama/${ollamaModel}`);

      if (enableSandbox) {
        runtime.log(`  Sandbox: Docker (tools run in isolated containers)`);
      } else {
        runtime.log(`  Sandbox: off (tools run on host)`);
      }

      runtime.log("");
      runtime.log("Setup complete! Your Gemma assistant is ready.");

      // Build Control UI assets so the gateway starts instantly.
      const { ensureControlUiAssetsBuilt } = await import("../infra/control-ui-assets.js");
      runtime.log("");
      runtime.log("Checking Control UI assets...");
      const uiBuild = await ensureControlUiAssetsBuilt(runtime);
      if (uiBuild.ok) {
        runtime.log(uiBuild.built ? "Control UI built." : "Control UI assets ready.");
      } else {
        runtime.error(`Control UI: ${uiBuild.message}`);
        runtime.error("The gateway will attempt to build them on first start.");
      }

      // Start the gateway on the host. Tool execution is sandboxed in Docker
      // containers via agents.defaults.sandbox when Docker is available.
      const gwPort = DEFAULT_GATEWAY_PORT;

      // Clean up any stale gateway process before starting fresh.
      killProcessesOnPort(gwPort);

      runtime.log("");
      runtime.log(`Starting gateway on port ${gwPort}...`);
      spawnGatewayDetached(gwPort);

      const ready = await waitForGatewayReady(gwPort);
      if (!ready) {
        runtime.error("Gateway did not become ready within 30 seconds.");
        runtime.error("You can start it manually with: gemmaclaw chat");
        runtime.log("");
        runtime.log(`Backend PID: ${result.handle.pid} (stop with: kill ${result.handle.pid})`);
        return;
      }
      runtime.log("Gateway is ready.");

      const chatUrl = `http://127.0.0.1:${gwPort}/`;
      runtime.log("");
      runtime.log(`Chat UI: ${chatUrl}`);
      runtime.log(`Backend PID: ${result.handle.pid} (stop with: kill ${result.handle.pid})`);
    } else {
      runtime.error(`Smoke test failed: ${verification.error}`);
      runtime.error("The backend started but could not generate a response.");
      runtime.error(
        "Try running again or use 'gemmaclaw setup --advanced' to pick a different backend.",
      );
      await result.handle.stop();
      runtime.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error(`Setup failed: ${message}`);
    runtime.error("");
    runtime.error("Troubleshooting:");
    runtime.error("  - Check network connectivity (runtimes and models are downloaded)");
    runtime.error("  - Try 'gemmaclaw setup --advanced' to pick a different backend");
    runtime.error("  - See 'gemmaclaw provision --help' for manual control");
    runtime.exit(1);
  }
}
