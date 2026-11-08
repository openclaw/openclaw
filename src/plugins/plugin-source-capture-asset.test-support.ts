import fs from "node:fs";
import path from "node:path";
import { resolveUpdateCandidatePluginPath } from "../infra/update-candidate-paths.js";
import {
  captureUpdateCandidatePluginAsset,
  sealUpdateCandidatePluginAssets,
} from "../infra/update-candidate-plugin-assets.js";
import { captureUpdateCandidatePluginCodeLink } from "../infra/update-candidate-plugin-code-links.js";

export async function createPrivateAssetFixture(directory: string) {
  const stateDir = fs.realpathSync(directory);
  fs.chmodSync(stateDir, 0o700);
  const rootDir = resolveUpdateCandidatePluginPath("/source-state", stateDir, "/external/plugin");
  const target = resolveUpdateCandidatePluginPath(
    "/source-state",
    stateDir,
    "/external/assets/config.json",
  );
  const authorizedResource = path.join(stateDir, "authorized-resource");
  const unavailableResource = path.join(stateDir, "unavailable-resource");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ backupPath: authorizedResource }));
  const link = path.join(rootDir, "config.json");
  fs.symlinkSync(target, link);
  const code = captureUpdateCandidatePluginCodeLink(
    link,
    fs.lstatSync(link, { bigint: true }),
    fs.readlinkSync(link),
  );
  const edge = captureUpdateCandidatePluginAsset(code, stateDir);
  const receipt = await sealUpdateCandidatePluginAssets(stateDir, [edge]);
  return {
    stateDir,
    rootDir,
    target,
    link,
    edge,
    receipt,
    authorizedResource,
    unavailableResource,
  };
}
