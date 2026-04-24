import readline from "node:readline/promises";
import type { HardwareInfo, SystemTools } from "./hardware.js";
import { DEFAULT_MODELS } from "./model-registry.js";
import type { BackendId } from "./types.js";

export type SetupProfile = {
  backend: BackendId;
  model?: string;
  port: number;
  reason: string;
};

// -----------------------------------------------------------------------
// Profile selection (pure logic, no I/O)
// -----------------------------------------------------------------------

/**
 * Select the safest backend for quick setup.
 *
 * Rules:
 *   1. Never default to gemma-cpp (requires HF_TOKEN + build tools).
 *   2. NVIDIA GPU detected -> Ollama (best GPU acceleration).
 *   3. x86_64 CPU, no GPU -> llama-cpp (efficient CPU inference, pre-built binary).
 *   4. arm64 or other arch -> Ollama (arm64 binary available, llama-cpp only ships x64).
 *   5. If a system binary is already installed, prefer that backend.
 */
export function selectQuickProfile(hw: HardwareInfo, tools: SystemTools): SetupProfile {
  // If the user already has a backend installed, prefer it (system-first).
  if (tools.ollamaInstalled && !tools.llamacppInstalled) {
    return {
      backend: "ollama",
      port: 11434,
      reason: "Ollama is already installed on this system.",
    };
  }
  if (tools.llamacppInstalled && !tools.ollamaInstalled && hw.cpu.arch === "x64") {
    return {
      backend: "llama-cpp",
      port: 8080,
      reason: "llama-server is already installed on this system.",
    };
  }

  // GPU detected -> Ollama.
  if (hw.gpu.detected && hw.gpu.nvidia) {
    return {
      backend: "ollama",
      port: 11434,
      reason: "NVIDIA GPU detected. Ollama provides the best GPU acceleration.",
    };
  }

  // x86_64 without GPU -> llama-cpp (pre-built binary, efficient CPU inference).
  if (hw.cpu.arch === "x64") {
    return {
      backend: "llama-cpp",
      port: 8080,
      reason: "CPU-only x86_64 system. llama.cpp offers efficient CPU inference.",
    };
  }

  // arm64 or other -> Ollama (has arm64 binaries; llama-cpp only ships x64).
  return {
    backend: "ollama",
    port: 11434,
    reason: `${hw.cpu.arch} system. Ollama provides the broadest hardware support.`,
  };
}

/**
 * Validate that a backend choice is viable given current system tools.
 * Returns null if OK, or an error message if not.
 */
export function validateBackendChoice(backend: BackendId, tools: SystemTools): string | null {
  if (backend === "gemma-cpp") {
    if (!tools.gitInstalled) {
      return "gemma.cpp requires git, which is not installed.";
    }
    if (!tools.cmakeInstalled) {
      return "gemma.cpp requires cmake, which is not installed.";
    }
    if (!tools.cppCompilerInstalled) {
      return "gemma.cpp requires a C++ compiler (g++ or clang++), which is not installed.";
    }
    if (!process.env.HF_TOKEN) {
      return (
        "gemma.cpp requires HF_TOKEN to download gated Gemma models.\n" +
        "  1. Create a token at https://huggingface.co/settings/tokens\n" +
        "  2. Accept the Gemma license at https://huggingface.co/google/gemma-2-2b-it\n" +
        '  3. Set: export HF_TOKEN="hf_..."'
      );
    }
  }
  if (backend === "llama-cpp" && process.arch !== "x64") {
    return `llama.cpp pre-built binaries are x86_64 only. Your system is ${process.arch}. Consider using Ollama instead.`;
  }
  return null;
}

/**
 * Return the display-friendly size string for a model.
 */
export function formatModelSize(sizeBytes?: number): string {
  if (!sizeBytes) {
    return "unknown size";
  }
  if (sizeBytes >= 1_000_000_000) {
    return `${(sizeBytes / 1_000_000_000).toFixed(1)} GB`;
  }
  return `${(sizeBytes / 1_000_000).toFixed(0)} MB`;
}

// -----------------------------------------------------------------------
// Interactive prompts (for advanced mode)
// -----------------------------------------------------------------------

export interface WizardIO {
  prompt(question: string): Promise<string>;
  log(msg: string): void;
  error(msg: string): void;
}

/**
 * Create a WizardIO backed by process stdin/stdout.
 */
export function createStdioWizardIO(): WizardIO & { close(): void } {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    prompt: (q: string) => rl.question(q),
    log: (msg: string) => console.log(msg),
    error: (msg: string) => console.error(msg),
    close: () => rl.close(),
  };
}

/**
 * Run the advanced interactive wizard, returning the user's choices.
 */
export async function runAdvancedWizard(
  io: WizardIO,
  hw: HardwareInfo,
  tools: SystemTools,
): Promise<SetupProfile> {
  // 1. Backend selection.
  io.log("");
  io.log("Available backends:");
  io.log(
    `  1) ollama   - Recommended for GPU setups (${formatModelSize(DEFAULT_MODELS.ollama.sizeBytes)} default model)`,
  );
  io.log(
    `  2) llama-cpp - Efficient CPU inference (${formatModelSize(DEFAULT_MODELS["llama-cpp"].sizeBytes)} default model)`,
  );
  io.log(
    `  3) gemma-cpp - CPU-first, requires cmake/g++/HF_TOKEN (${formatModelSize(DEFAULT_MODELS["gemma-cpp"].sizeBytes)} default model)`,
  );
  io.log("");

  let backend: BackendId = "ollama";
  for (;;) {
    const input = await io.prompt("Backend [1/2/3, default=1]: ");
    const choice = input.trim() || "1";
    if (choice === "1" || choice === "ollama") {
      backend = "ollama";
      break;
    }
    if (choice === "2" || choice === "llama-cpp") {
      backend = "llama-cpp";
      break;
    }
    if (choice === "3" || choice === "gemma-cpp") {
      backend = "gemma-cpp";
      break;
    }
    io.error(`Invalid choice: "${choice}". Enter 1, 2, or 3.`);
  }

  // Validate the backend choice.
  const validation = validateBackendChoice(backend, tools);
  if (validation) {
    io.error("");
    io.error(`Warning: ${validation}`);
    const proceed = await io.prompt("Continue anyway? [y/N]: ");
    if (proceed.trim().toLowerCase() !== "y") {
      io.log("Aborted. Pick a different backend or install the missing dependencies.");
      process.exit(0);
    }
  }

  // 2. Model selection.
  const defaultModel = DEFAULT_MODELS[backend];
  const modelInput = await io.prompt(
    `Model [default: ${defaultModel.id} (${formatModelSize(defaultModel.sizeBytes)})]: `,
  );
  const model = modelInput.trim() || undefined;

  // 3. Port selection.
  const defaultPort = backend === "ollama" ? 11434 : backend === "llama-cpp" ? 8080 : 11436;
  const portInput = await io.prompt(`Port [default: ${defaultPort}]: `);
  let port = defaultPort;
  if (portInput.trim()) {
    const parsed = Number.parseInt(portInput.trim(), 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      io.error(`Invalid port "${portInput.trim()}", using default ${defaultPort}.`);
    } else {
      port = parsed;
    }
  }

  return {
    backend,
    model,
    port,
    reason: "User-selected in advanced setup.",
  };
}
