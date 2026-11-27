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
  ['endpointClass === "openrouter" || endpointClass === "together"', 1],
  ["const lean = isLocalModelLeanEnabled(config);", 1],
  ["if (capabilities.usesExplicitProxyLikeEndpoint) {", 1],
  ['case "anthropic-messages":', 1],
  ['modelId.startsWith("claude-")', 1],
  ["isNativeOpenAIEndpoint(model)", 1],
  ["compat.supportsPromptCacheKey === true", 0],
  ["supportsClaudeAdaptiveThinking(model)", 1],
  ["if (policy.preserveSignatures) {", 0],
  ["provider === expectedProvider", 0],
])("counts %s as %i branch on the request path", (line, count) => {
  expect(countProviderBranches(`const request = { tools: [] };\n${line}`)).toBe(count);
});

it("ignores files that name no request or history concept", () => {
  expect(countProviderBranches('if (provider === "zai") {')).toBe(0);
});

it("passes at the allowlisted count and fails when a file adds a branch", () => {
  const root = tempDirs.make("openclaw-provider-branching-");
  const { write } = fixtureFiles(root);
  const sourcePath = "src/agents/example.ts";
  const lean =
    'export const lean = (systemPrompt: string, provider: string) => provider === "ollama";\n';
  write(sourcePath, lean);
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
