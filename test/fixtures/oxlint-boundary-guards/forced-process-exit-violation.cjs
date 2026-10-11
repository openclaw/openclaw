const nodeProcess = require("node:process");
const alias = nodeProcess;
alias.exit(1);
require("process").reallyExit(1);
const { exit: terminate } = require("node:process");
const { reallyExit: immediate } = alias;
alias["exit"].apply(alias, [1]);
const { default: defaultProcess } = require("process");
defaultProcess.exit(1);

function localRequire(require) {
  require("node:process").exit(1);
}
const text = "require('process').exit(1)";
module.exports = { localRequire, text };
