import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { registerCapabilityCli } from "./capability-cli.js";
import { collectShellCompletionCommandTree } from "./completion-command-tree.js";

const rejectRuntimeImport = vi.hoisted(() => () => {
  throw new Error("Inference help must not load execution runtimes");
});

vi.mock("./capability-cli/shared.js", rejectRuntimeImport);
vi.mock("./capability-cli/local-account-secrets.js", rejectRuntimeImport);
vi.mock("../config/config.js", rejectRuntimeImport);
vi.mock("../agents/prepared-model-catalog.js", rejectRuntimeImport);
vi.mock("../agents/simple-completion-runtime.js", rejectRuntimeImport);
vi.mock("../image-generation/runtime.js", rejectRuntimeImport);
vi.mock("../media-understanding/runtime.js", rejectRuntimeImport);
vi.mock("./capability-cli/tts-runtime.js", rejectRuntimeImport);
vi.mock("../video-generation/runtime.js", rejectRuntimeImport);
vi.mock("../web-search/runtime.js", rejectRuntimeImport);
vi.mock("../web-fetch/runtime.js", rejectRuntimeImport);
vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", rejectRuntimeImport);
vi.mock("../gateway/call.js", rejectRuntimeImport);
vi.mock("./command-secret-targets.js", rejectRuntimeImport);

const domainExamples = [
  { args: ["model", "auth", "login"], option: "--provider" },
  { args: ["image", "generate"], option: "--prompt" },
  { args: ["audio", "transcribe"], option: "--language" },
  { args: ["tts", "convert"], option: "--voice" },
  { args: ["video", "generate"], option: "--duration" },
  { args: ["web", "search"], option: "--query" },
  { args: ["embedding", "create"], option: "--text" },
];

it("retains nested inference commands and aliases for completion without loading execution runtimes", async () => {
  const program = new Command().name("openclaw");
  await registerCapabilityCli(program, ["node", "openclaw", "completion", "--shell", "bash"]);
  const { descendants } = collectShellCompletionCommandTree(program);
  for (const name of ["infer", "capability"]) {
    for (const { args, option } of domainExamples) {
      const path = [name, ...args].join(" ");
      const context = descendants.find((candidate) =>
        candidate.pathVariants.some((variant) => variant.join(" ") === path),
      );
      expect(context?.completions, path).toContain(option);
    }
  }
});
