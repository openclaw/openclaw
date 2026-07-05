const {
  tryExtractUsableToolCallArguments,
} = require("./out/agents/embedded-agent-runner/run/attempt.tool-call-argument-repair.js");
console.log(
  tryExtractUsableToolCallArguments(
    '{"name": "tool_search", "parameters": {"query": "test"}}',
    "tool_search",
  ),
);
