import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { downloadFile, extractTarGz, fileExists, waitForHealthy, whichBinary } from "./download.js";
import { DEFAULT_MODELS, resolveOllamaBinaryUrl } from "./model-registry.js";
import type { ProvisionProgress, RuntimeHandle, RuntimeManager } from "./types.js";
import { resolveModelsDir, resolveRuntimeDir } from "./types.js";

const BACKEND_ID = "ollama" as const;

function binaryPath(): string {
  return path.join(resolveRuntimeDir(BACKEND_ID), "ollama");
}

async function resolveBinary(): Promise<string> {
  // Prefer system-installed Ollama.
  const systemBin = await whichBinary("ollama");
  if (systemBin) {
    return systemBin;
  }

  const localBin = binaryPath();
  if (await fileExists(localBin)) {
    return localBin;
  }

  throw new Error("Ollama is not installed. Run install() first.");
}

export function createOllamaManager(): RuntimeManager {
  return {
    id: BACKEND_ID,
    displayName: "Ollama",
    defaultPort: 11434,

    async isInstalled(): Promise<boolean> {
      const systemBin = await whichBinary("ollama");
      if (systemBin) {
        return true;
      }
      return fileExists(binaryPath());
    },

    async install(progress?: ProvisionProgress): Promise<void> {
      if (await this.isInstalled()) {
        progress?.("Ollama is already installed.");
        return;
      }

      const url = resolveOllamaBinaryUrl();
      const runtimeDir = resolveRuntimeDir(BACKEND_ID);
      const archiveDest = path.join(runtimeDir, "ollama.tgz");
      progress?.(`Downloading Ollama from ${url}...`);

      const result = await downloadFile(url, archiveDest, {
        onProgress: (bytes, total) => {
          if (total) {
            const pct = Math.round((bytes / total) * 100);
            progress?.(`Downloading Ollama... ${pct}%`);
          }
        },
      });

      progress?.("Extracting Ollama...");
      await extractTarGz(archiveDest, runtimeDir);
      await fs.unlink(archiveDest).catch(() => {});

      // The archive extracts to bin/ollama. Move it to the expected location.
      const extractedBin = path.join(runtimeDir, "bin", "ollama");
      const dest = binaryPath();
      try {
        await fs.access(extractedBin);
        await fs.rename(extractedBin, dest);
        await fs.rm(path.join(runtimeDir, "bin"), { recursive: true, force: true });
      } catch {
        // Some versions extract directly as "ollama" in the root.
      }

      await fs.chmod(dest, "755");
      progress?.(`Ollama installed (sha256: ${result.sha256.slice(0, 12)}...).`);
    },

    async start(port?: number): Promise<RuntimeHandle> {
      const actualPort = port ?? this.defaultPort;
      const bin = await resolveBinary();
      const modelsDir = resolveModelsDir(BACKEND_ID);
      await fs.mkdir(modelsDir, { recursive: true });

      const child: ChildProcess = spawn(bin, ["serve"], {
        env: {
          ...process.env,
          OLLAMA_HOST: `127.0.0.1:${actualPort}`,
          OLLAMA_MODELS: modelsDir,
        },
        stdio: "ignore",
        detached: true,
      });

      child.unref();
      const pid = child.pid;
      if (!pid) {
        throw new Error("Failed to start Ollama: no PID.");
      }

      const baseUrl = `http://127.0.0.1:${actualPort}`;
      const healthy = await waitForHealthy(baseUrl, { timeoutMs: 15_000 });
      if (!healthy) {
        child.kill("SIGTERM");
        throw new Error(`Ollama did not become healthy at ${baseUrl} within 15s.`);
      }

      return {
        pid,
        port: actualPort,
        apiBaseUrl: baseUrl,
        async stop() {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Already exited.
          }
        },
      };
    },

    async healthcheck(port: number): Promise<boolean> {
      try {
        const res = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    async pullModel(modelId: string, port: number, progress?: ProvisionProgress): Promise<void> {
      const tag = modelId || DEFAULT_MODELS.ollama.ollamaTag!;
      const baseUrl = `http://127.0.0.1:${port}`;

      progress?.(`Pulling model ${tag}...`);

      const response = await fetch(`${baseUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tag }),
      });

      if (!response.ok) {
        throw new Error(`Failed to pull ${tag}: HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error(`No response body while pulling ${tag}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            const chunk = JSON.parse(line) as {
              status?: string;
              total?: number;
              completed?: number;
              error?: string;
            };
            if (chunk.error) {
              throw new Error(`Pull failed: ${chunk.error}`);
            }
            if (chunk.status && chunk.total && chunk.completed !== undefined) {
              const pct = Math.round((chunk.completed / chunk.total) * 100);
              progress?.(`Pulling ${tag}: ${chunk.status} ${pct}%`);
            } else if (chunk.status) {
              progress?.(`Pulling ${tag}: ${chunk.status}`);
            }
          } catch (err) {
            if (err instanceof Error && err.message.startsWith("Pull failed:")) {
              throw err;
            }
          }
        }
      }

      progress?.(`Model ${tag} pulled successfully.`);
    },
  };
}
