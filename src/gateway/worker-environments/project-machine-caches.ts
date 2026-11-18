import { z } from "zod";
import { INSPECT_NODE_TOOLCHAIN_JS } from "./node-toolchain-inspection.js";
import { RECEIPT_MATCH_JS, VERIFY_INSTALL_JS } from "./worker-bundle-inspection.js";

export const PreparedNodeToolchain = z.strictObject({
  version: z.string().regex(/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/u),
  platform: z.literal("linux"),
  arch: z.enum(["x64", "arm64"]),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const ValidatedMachineCaches = z.strictObject({
  nodeToolchain: PreparedNodeToolchain.optional(),
  workerBundle: z.strictObject({ bundleHash: z.string().regex(/^[a-f0-9]{64}$/u) }).optional(),
});

/** Snapshot-only inspection of machine caches outside the prepared workspace manifest. */
export const INSPECT_PROJECT_MACHINE_CACHES_JS = `async (machineHome, homeDir, nodeToolchain, workerBundle) => {
  const fs = require("node:fs"), path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const root = path.join(machineHome, ".openclaw-worker");
  const facts = {};
  if (fs.existsSync(path.join(root, "toolchains"))) {
    if (!nodeToolchain) throw new Error("Snapshot Node cache has no completed preparation admission");
    facts.nodeToolchain = await (${INSPECT_NODE_TOOLCHAIN_JS})(machineHome, nodeToolchain);
    const key = nodeToolchain.version + "-linux-" + nodeToolchain.arch + "-" + nodeToolchain.archiveSha256;
    const owned = (directory, names) => {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || fs.realpathSync(directory) !== directory || fs.readdirSync(directory).sort().join("\\0") !== names.sort().join("\\0")) throw new Error("Snapshot Node cache contains unknown state");
    };
    owned(path.join(root, "toolchains"), ["node"]);
    owned(path.join(root, "toolchains", "node"), [key]);
    if (fs.realpathSync(path.join(homeDir, ".local", "bin", "node")) !== path.join(root, "toolchains", "node", key, "bin", "node")) throw new Error("Prepared Node selection changed");
  } else if (nodeToolchain) throw new Error("Completed Node cache is unavailable");
  const bundles = fs.readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name));
  if (bundles.length) {
    if (!workerBundle || bundles.length !== 1 || bundles[0] !== workerBundle.bundleHash) throw new Error("Snapshot worker cache is not the current bundle");
    const directory = path.join(root, workerBundle.bundleHash);
    for (const [script, args] of [
      [${JSON.stringify(VERIFY_INSTALL_JS)}, [directory, workerBundle.bundleHash, "bundle", "inspect"]],
      [${JSON.stringify(RECEIPT_MATCH_JS)}, [path.join(directory, "bootstrap-receipt.json"), JSON.stringify(workerBundle), "inspect"]],
    ]) {
      const result = spawnSync(process.execPath, ["-e", script, ...args], { stdio: "ignore", timeout: 600000 });
      if (result.status !== 0) throw new Error("Snapshot current worker bundle verification failed");
    }
    facts.workerBundle = { bundleHash: workerBundle.bundleHash };
  }
  return Object.keys(facts).length ? facts : undefined;
}`;
