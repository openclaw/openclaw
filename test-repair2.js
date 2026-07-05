const fs = require("fs");
const content = fs.readFileSync(
  "out/agents/embedded-agent-runner/run/attempt.tool-call-argument-repair.js",
  "utf8",
);
// wait I can't require ES modules, but I can use an import script!
