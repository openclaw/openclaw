import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  BUNDLE_ARTIFACT,
  NODE_BOOTSTRAP,
  createProvider,
  createService,
  testState,
} from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export { awaitGateBeforeSettlement as beforeSettlement } from "../../../test/helpers/promise.js";

type Service = ReturnType<typeof createService>;
type Request = Parameters<Service["createWithRequest"]>[0];

export function nodeArtifacts(enabledPluginIds = NODE_BOOTSTRAP.enabledPluginIds) {
  return {
    artifacts: {
      nodeBootstrapSha256: NODE_BOOTSTRAP.sha256,
      workerBundleHash: BUNDLE_ARTIFACT.bundleHash,
      workerArchiveSha256: BUNDLE_ARTIFACT.tarballSha256,
      enabledPluginIds: [...enabledPluginIds],
      openclawVersion: BUNDLE_ARTIFACT.openclawVersion,
      protocolFeatures: [...BUNDLE_ARTIFACT.protocolFeatures],
    },
    assertCurrent: () => {},
  };
}

export async function pendingNodeEnrollment(
  record: WorkerEnvironmentRecord,
  waitForDeviceId: () => Promise<string>,
  openclawVersion = NODE_BOOTSTRAP.openclawVersion,
) {
  const pending = await testState.store.ensureNodeEnrollment(record.environmentId);
  return {
    mode: "connect" as const,
    setupId: expectDefined(pending.nodeSetupId, "pending node enrollment"),
    setupCode: "synthetic-setup",
    displayName: "Fixture node",
    openclawVersion,
    nodeBootstrap: { ...NODE_BOOTSTRAP, openclawVersion },
    waitForDeviceId,
  };
}

export function providerService(
  provider: Parameters<typeof createProvider>[0] = {},
  options: Parameters<typeof createService>[1] = {},
) {
  return createService(createProvider(provider), options);
}

export function create(
  service: Service,
  idempotencyKey: string,
  options: Omit<Request, "profileId" | "idempotencyKey"> = {},
) {
  return service.createWithRequest({ profileId: "development", idempotencyKey, ...options });
}

export async function repository(
  name: string,
  options: { empty?: boolean; setup?: boolean; disableSigning?: boolean; content?: string } = {},
) {
  const root = path.join(testState.root, name);
  await fs.mkdir(root);
  await requireGit(root, ["init", "--quiet"]);
  await requireGit(root, ["config", "user.name", "Project Test"]);
  await requireGit(root, ["config", "user.email", "project@example.invalid"]);
  if (options.disableSigning) {
    await requireGit(root, ["config", "commit.gpgsign", "false"]);
  }
  if (!options.empty) {
    await fs.writeFile(path.join(root, "input.txt"), options.content ?? `${name} base\n`);
  }
  if (options.setup) {
    await fs.mkdir(path.join(root, ".openclaw"));
    await fs.writeFile(path.join(root, ".openclaw/worktree-setup.sh"), "#!/bin/sh\ntrue\n", {
      mode: 0o755,
    });
  }
  if (!options.empty) {
    await requireGit(root, ["add", "."]);
  }
  await requireGit(root, ["commit", "--quiet", "--allow-empty", "-m", "base"]);
  return { root, baseCommit: await requireGit(root, ["rev-parse", "HEAD"]) };
}
