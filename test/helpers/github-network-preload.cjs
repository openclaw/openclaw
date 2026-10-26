// A first synchronous --require installs before caller preloads, including ESM
// imports. It also covers CommonJS eval workers, which skip ESM --import hooks.
require("./github-network-guard.mjs").installGitHubNetworkGuard();
