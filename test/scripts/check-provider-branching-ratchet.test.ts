import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { countProviderBranches, main } from "../../scripts/check-provider-branching-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  ['if (provider === "zai") {', 1],
  ["const native = model.api !== `openai-responses`;", 1],
  ['endpointClass === "openrouter" || endpointClass === "together"', 2],
  ['normalizedProvider === "openai"', 1],
  ['url.hostname === "api.anthropic.com"', 1],
  ["const lean = isLocalModelLeanEnabled(config);", 1],
  ["if (capabilities.usesExplicitProxyLikeEndpoint) {", 1],
  ['case "zai":', 1],
  ['modelId.startsWith("claude-")', 1],
  ['baseUrl.includes("openrouter.ai")', 1],
  ["/^gpt-5/i.test(modelId)", 1],
  ["SIGNED_THINKING_PROVIDERS.has(model.provider)", 1],
  ["isNativeOpenAIEndpoint(model)", 1],
  ["isOpenAIGpt6Model(model)", 1],
  ["shouldDropClaudeThinkingBlocks(model)", 1],
  ["function supportsClaudeAdaptiveThinking(model: Model) {", 0],
  ["compat.supportsPromptCacheKey === true", 0],
  ["isModelSelectionLocked(session)", 0],
  ['transport === "sse"', 0],
  ['import { isLocalModelLeanEnabled } from "./local-model-lean.js";', 0],
  ['if (host === "gateway") {', 0],
  ['typeof params.provider === "string"', 0],
  ["if (policy.preserveSignatures) {", 0],
  ["provider === expectedProvider", 0],
])("counts %s as %i", (source, count) => {
  expect(countProviderBranches(source)).toBe(count);
});

it("passes at the allowlisted count and fails when a file adds a branch", () => {
  const root = tempDirs.make("openclaw-provider-branching-");
  const { write } = fixtureFiles(root);
  const sourcePath = "src/agents/example.ts";
  const lean = 'export const lean = (provider: string) => provider === "ollama";\n';
  write(sourcePath, lean);
  // Test helpers are out of scope, including files inside a test-helpers directory.
  write("src/agents/test-helpers/live-candidates.ts", lean);
  write("config/provider-branching-allowlist.txt", `${sourcePath}\t1\n`);
  for (const args of [["init"], ["add", "."], ["commit", "-m", "fixture"]]) {
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      env: createNestedGitEnv(),
      stdio: "ignore",
    });
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(main(root, ["--base", "HEAD"]), JSON.stringify(errors.mock.calls)).toBe(0);

  write(
    sourcePath,
    `${lean}export const zai = (model: { provider: string }) => model.provider === "zai";\n`,
  );
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${sourcePath}: 2 > 1`));
});
