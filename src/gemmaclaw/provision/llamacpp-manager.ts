import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { downloadFile, extractZip, fileExists, waitForHealthy, whichBinary } from "./download.js";
import { DEFAULT_MODELS, resolveLlamaCppUrl } from "./model-registry.js";
import type { ProvisionProgress, RuntimeHandle, RuntimeManager } from "./types.js";
import { resolveModelsDir, resolveRuntimeDir } from "./types.js";

const BACKEND_ID = "llama-cpp" as const;

function serverBinaryPath(): string {
  return path.join(resolveRuntimeDir(BACKEND_ID), "bin", "llama-server");
}

function alternateServerBinaryPath(): string {
  // Some builds name it "server" instead of "llama-server".
  return path.join(resolveRuntimeDir(BACKEND_ID), "bin", "server");
}

async function resolveServerBinary(): Promise<string> {
  // Check system PATH first.
  const systemBin = await whichBinary("llama-server");
  if (systemBin) {
    return systemBin;
  }

  const localBin = serverBinaryPath();
  if (await fileExists(localBin)) {
    return localBin;
  }

  const altBin = alternateServerBinaryPath();
  if (await fileExists(altBin)) {
    return altBin;
  }

  // Also check flat extraction (some releases extract without bin/ subdir).
  const flatBin = path.join(resolveRuntimeDir(BACKEND_ID), "llama-server");
  if (await fileExists(flatBin)) {
    return flatBin;
  }

  // Some release zips extract to build/bin/ instead of bin/.
  const buildBin = path.join(resolveRuntimeDir(BACKEND_ID), "build", "bin", "llama-server");
  if (await fileExists(buildBin)) {
    return buildBin;
  }

  throw new Error("llama-server is not installed. Run install() first.");
}

function defaultModelPath(): string {
  return path.join(resolveModelsDir(BACKEND_ID), `${DEFAULT_MODELS["llama-cpp"].id}.gguf`);
}

export function createLlamaCppManager(): RuntimeManager {
  return {
    id: BACKEND_ID,
    displayName: "llama.cpp",
    defaultPort: 8080,

    async isInstalled(): Promise<boolean> {
      const systemBin = await whichBinary("llama-server");
      if (systemBin) {
        return true;
      }

      if (await fileExists(serverBinaryPath())) {
        return true;
      }
      if (await fileExists(alternateServerBinaryPath())) {
        return true;
      }

      const flatBin = path.join(resolveRuntimeDir(BACKEND_ID), "llama-server");
      if (await fileExists(flatBin)) {
        return true;
      }
      const buildBin = path.join(resolveRuntimeDir(BACKEND_ID), "build", "bin", "llama-server");
      return fileExists(buildBin);
    },

    async install(progress?: ProvisionProgress): Promise<void> {
      if (await this.isInstalled()) {
        progress?.("llama.cpp server is already installed.");
        return;
      }

      const url = resolveLlamaCppUrl();
      const runtimeDir = resolveRuntimeDir(BACKEND_ID);
      const archivePath = path.join(runtimeDir, "llama-cpp.zip");

      progress?.(`Downloading llama.cpp from ${url}...`);
      await fs.mkdir(runtimeDir, { recursive: true });

      const result = await downloadFile(url, archivePath, {
        onProgress: (bytes, total) => {
          if (total) {
            const pct = Math.round((bytes / total) * 100);
            progress?.(`Downloading llama.cpp... ${pct}%`);
          }
        },
      });

      progress?.(`Extracting llama.cpp (sha256: ${result.sha256.slice(0, 12)}...)...`);
      await extractZip(archivePath, runtimeDir);
      await fs.unlink(archivePath).catch(() => {});

      // Make all binaries executable. Check multiple possible layouts.
      for (const binDir of [path.join(runtimeDir, "bin"), path.join(runtimeDir, "build", "bin")]) {
        try {
          const entries = await fs.readdir(binDir);
          for (const entry of entries) {
            await fs.chmod(path.join(binDir, entry), "755").catch(() => {});
          }
        } catch {
          // Directory doesn't exist, try next.
        }
      }
      // Also try flat layout.
      try {
        const entries = await fs.readdir(runtimeDir);
        for (const entry of entries) {
          if (entry.includes("llama") || entry === "server") {
            await fs.chmod(path.join(runtimeDir, entry), "755").catch(() => {});
          }
        }
      } catch {
        // Ignore.
      }

      progress?.("llama.cpp server installed.");
    },

    async start(port?: number): Promise<RuntimeHandle> {
      const actualPort = port ?? this.defaultPort;
      const bin = await resolveServerBinary();
      const modelPath = defaultModelPath();

      if (!(await fileExists(modelPath))) {
        throw new Error(`Model file not found at ${modelPath}. Run pullModel() first.`);
      }

      // The release zip bundles libllama.so alongside the binary. Set
      // LD_LIBRARY_PATH so the dynamic linker can find it.
      const binDir = path.dirname(bin);
      const ldPath = [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");

      // Capture stderr for diagnostics. Using "pipe" without consuming
      // the stream would block the child when the OS pipe buffer fills,
      // so we drain both streams into a ring buffer.
      const child: ChildProcess = spawn(
        bin,
        [
          "--model",
          modelPath,
          "--port",
          String(actualPort),
          "--host",
          "127.0.0.1",
          "--ctx-size",
          "2048",
          "--n-predict",
          "256",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, LD_LIBRARY_PATH: ldPath },
          detached: true,
        },
      );

      // Drain stdout/stderr so the pipe buffer never fills and blocks the child.
      let stderrTail = "";
      child.stdout?.resume();
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096);
      });

      child.unref();
      const pid = child.pid;
      if (!pid) {
        throw new Error("Failed to start llama-server: no PID.");
      }

      const baseUrl = `http://127.0.0.1:${actualPort}`;
      const healthy = await waitForHealthy(`${baseUrl}/health`, {
        timeoutMs: 120_000,
        intervalMs: 1000,
      });
      if (!healthy) {
        child.kill("SIGTERM");
        const hint = stderrTail.trim() ? `\nServer stderr (last 4 KB):\n${stderrTail.trim()}` : "";
        throw new Error(`llama-server did not become healthy at ${baseUrl} within 120s.${hint}`);
      }

      // Detach from the streams now that the server is healthy.
      child.stdout?.destroy();
      child.stderr?.destroy();

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
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    async pullModel(modelId: string, _port: number, progress?: ProvisionProgress): Promise<void> {
      const model = DEFAULT_MODELS["llama-cpp"];

      // If modelId is a URL, use it directly; otherwise use the registered default URL.
      const isUrl = modelId.startsWith("http://") || modelId.startsWith("https://");
      const url = isUrl ? modelId : model.url;
      if (!url) {
        throw new Error("No model URL provided and no default URL configured for llama-cpp.");
      }

      const modelsDir = resolveModelsDir(BACKEND_ID);
      // Always use model.id for the filename so start() can find it via defaultModelPath().
      const fileName = `${model.id}.gguf`;
      const dest = path.join(modelsDir, fileName);

      if (await fileExists(dest)) {
        progress?.(`Model already downloaded at ${dest}.`);
        return;
      }

      progress?.(`Downloading GGUF model from ${url}...`);
      const result = await downloadFile(url, dest, {
        expectedSha256: model.sha256,
        onProgress: (bytes, total) => {
          if (total) {
            const pct = Math.round((bytes / total) * 100);
            progress?.(`Downloading model... ${pct}%`);
          }
        },
      });

      progress?.(
        `Model downloaded (sha256: ${result.sha256.slice(0, 12)}..., ${result.bytesWritten} bytes).`,
      );
    },
  };
}
