import { resolveAllowAlwaysPatternsAsync } from "./src/infra/exec-approvals-allowlist.js";
import { evaluateShellAllowlist } from "./src/infra/exec-approvals-allowlist.js";

async function run() {
  const result = evaluateShellAllowlist({
    command: "id",
    allowlist: [],
    safeBins: new Set(["jq", "cut", "uniq", "head", "tail", "tr", "wc"]),
  });
  console.log("Evaluation Analysis OK:", result.analysisOk);

  const { patterns, unresolved } = await resolveAllowAlwaysPatternsAsync({
    segments: result.segments,
  });
  console.log("Patterns:", patterns);
  console.log("Unresolved:", unresolved);

  const jqResult = evaluateShellAllowlist({
    command: "jq -r '.version' package.json",
    allowlist: [],
    safeBins: new Set(["jq", "cut", "uniq", "head", "tail", "tr", "wc"]),
  });

  const jqAsync = await resolveAllowAlwaysPatternsAsync({ segments: jqResult.segments });
  console.log("JQ Patterns:", jqAsync.patterns);
  console.log("JQ Unresolved:", jqAsync.unresolved);

  const missingResult = evaluateShellAllowlist({
    command: "this_command_does_not_exist_123",
    allowlist: [],
    safeBins: new Set(["jq", "cut", "uniq", "head", "tail", "tr", "wc"]),
  });

  const missingAsync = await resolveAllowAlwaysPatternsAsync({ segments: missingResult.segments });
  console.log("Missing Patterns:", missingAsync.patterns);
  console.log("Missing Unresolved:", missingAsync.unresolved);
}

run().catch(console.error);
