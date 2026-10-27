import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initializeRepository, invokeProjectMethod } from "./projects.test-support.js";

export const projectConfig = (workspace: string) => ({
  agents: { entries: { main: { workspace } } },
});

export function expectProjectAccessChanged(
  result: Awaited<ReturnType<typeof invokeProjectMethod>>,
) {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", message: expect.stringContaining("Project access changed") },
  });
  expect(result?.payload).toBeUndefined();
}

export async function expectCheckoutInUse(
  repo: string,
  id: string,
  cfg: Parameters<typeof invokeProjectMethod>[2],
  reference: string,
) {
  expect(
    await invokeProjectMethod("projects.remove", { id, deleteCheckout: true }, cfg),
  ).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining(reference) },
  });
  await expect(fs.stat(repo)).resolves.toBeDefined();
}

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
