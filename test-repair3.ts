import { tryExtractUsableToolCallArguments } from "./src/agents/embedded-agent-runner/run/attempt.tool-call-argument-repair.ts";
console.log(
  tryExtractUsableToolCallArguments('{"name":"read","parameters":{"path":"/tmp/a"}}', "read"),
);
