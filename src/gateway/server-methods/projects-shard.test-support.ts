import path from "node:path";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initializeRepository } from "./projects.test-support.js";

export async function clonedProject(state: OpenClawTestState, name: string, displayName: string) {
  const originUrl = `https://github.com/acme/${name}.git`;
  const fingerprint = sha256HexPrefixCore(originUrl, 16);
  const repo = await initializeRepository(
    path.join(state.stateDir, "projects", fingerprint),
    name,
    originUrl,
  );
  const project = await registerClonedProjectRegistry({ path: repo, name: displayName, originUrl });
  return { repo, project, originUrl, fingerprint };
}
