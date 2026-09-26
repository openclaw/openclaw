import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { registerCapabilityCli } from "./capability-cli.js";
import { collectShellCompletionCommandTree } from "./completion-command-tree.js";

vi.mock("./capability-cli/shared.js", () => {
  throw new Error("Inference help must not load provider configuration or auth runtime");
});
vi.mock("./capability-cli/local-account-secrets.js", () => {
  throw new Error("Inference help must not load account secret preparation");
});
vi.mock("../config/config.js", () => {
  throw new Error("Inference help must not load configuration runtime");
});
vi.mock("../agents/prepared-model-catalog.js", () => {
  throw new Error("Inference help must not load the prepared model catalog");
});
vi.mock("../agents/simple-completion-runtime.js", () => {
  throw new Error("Inference help must not load model execution runtime");
});
vi.mock("../image-generation/runtime.js", () => {
  throw new Error("Inference help must not load image execution runtime");
});
vi.mock("../media-understanding/runtime.js", () => {
  throw new Error("Inference help must not load media execution runtime");
});
vi.mock("./capability-cli/tts-runtime.js", () => {
  throw new Error("Inference help must not load speech execution runtime");
});
vi.mock("../video-generation/runtime.js", () => {
  throw new Error("Inference help must not load video execution runtime");
});
vi.mock("../web-search/runtime.js", () => {
  throw new Error("Inference help must not load web search execution runtime");
});
vi.mock("../web-fetch/runtime.js", () => {
  throw new Error("Inference help must not load web fetch execution runtime");
});
vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => {
  throw new Error("Inference help must not load embedding execution runtime");
});
vi.mock("../gateway/call.js", () => {
  throw new Error("Inference help must not load Gateway transport");
});
vi.mock("./command-secret-targets.js", () => {
  throw new Error("Inference help must not load command secret resolution");
});

const domainExamples = [
  { args: ["model", "auth", "login"], option: "--provider" },
  { args: ["image", "generate"], option: "--prompt" },
  { args: ["audio", "transcribe"], option: "--language" },
  { args: ["tts", "convert"], option: "--voice" },
  { args: ["video", "generate"], option: "--duration" },
  { args: ["web", "search"], option: "--query" },
  { args: ["embedding", "create"], option: "--text" },
];

it.each(["infer", "capability"])(
  "renders complete %s parent help without loading execution runtimes",
  async (name) => {
    let output = "";
    const program = new Command()
      .name("openclaw")
      .exitOverride()
      .configureOutput({ writeOut: (text) => (output += text) });
    const args = [name, "--help"];
    await registerCapabilityCli(program, ["node", "openclaw", ...args]);
    await expect(program.parseAsync(args, { from: "user" })).rejects.toMatchObject({
      code: "commander.helpDisplayed",
      exitCode: 0,
    });
    for (const {
      args: [domain],
    } of domainExamples) {
      expect(output).toContain(domain);
    }
    expect(output).toContain("list");
    expect(output).toContain("inspect");
  },
);

it.each(domainExamples)(
  "renders detailed help for $args without loading execution runtimes",
  async ({ args, option }) => {
    let output = "";
    const program = new Command()
      .name("openclaw")
      .exitOverride()
      .configureOutput({ writeOut: (text) => (output += text) });
    const invocation = ["infer", ...args, "--help"];
    await registerCapabilityCli(program, ["node", "openclaw", ...invocation]);
    await expect(program.parseAsync(invocation, { from: "user" })).rejects.toMatchObject({
      code: "commander.helpDisplayed",
      exitCode: 0,
    });
    expect(output).toContain(option);
  },
);

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
