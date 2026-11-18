import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_BUNDLE_INSTALL_COMMAND } from "../infra/node-commands.js";
import * as openclawRoot from "../infra/openclaw-root.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import type { NodeHostClient } from "./client.js";
import { handleInvoke } from "./invoke.js";
import { preparePackagedNodeWorkerBundle } from "./node-worker-bundle-cache.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { buildBundleFixture } from "./node-worker-bundle-installer.test-support.js";
import {
  binding,
  createPreparedWorkspaceFixture,
} from "./node-worker-prepared-workspace.test-support.js";
import * as workspaceCommands from "./node-worker-workspace-commands.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});
function fixture() {
  return createPreparedWorkspaceFixture(tempDirs.make("node-snapshot-startup-"), true);
}
function replyClient(replies: unknown[]): NodeHostClient {
  return {
    request: async (_method, params) => {
      replies.push(params);
      throw new Error("Fixture transport has no reply payload");
    },
  };
}

describe("node snapshot startup custody", () => {
  it("invalidates matching snapshot content after an admitted node command writes before binding", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "fixture",
        pluginName: "Fixture",
        source: "test",
        command: {
          command: "fixture.write",
          handle: async () => {
            await fs.writeFile(
              path.join(f.workspaceDir, "source.txt"),
              "changed after registration\n",
            );
            return "{}";
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    const replies: unknown[] = [];
    try {
      await handleInvoke(
        { id: "snapshot-writer", nodeId: "node", command: "fixture.write" },
        replyClient(replies),
        { current: async () => [] },
        undefined,
        { workerWorkspace: f.runtime },
      );
      expect(replies).toContainEqual(expect.objectContaining({ ok: true, payloadJSON: "{}" }));
      expect(await fs.readFile(path.join(f.workspaceDir, "source.txt"), "utf8")).toBe(
        "changed after registration\n",
      );
      await expect(
        f.runtime.prepare({
          ...binding,
          initialSnapshot: {
            checkpointId: "checkpoint-fresh",
            baseCommit: f.baseCommit,
            sourceManifestRef: f.registration.sourceManifestRef,
            preparedManifestRef: f.registration.preparedManifestRef,
          },
        }),
      ).rejects.toThrow("does not match its manifest");
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it.each(["snapshot fast path", "prewarm fallback"] as const)(
    "keeps workspace provenance only across non-executing bundle admission: %s",
    async (mode) => {
      const f = await fixture();
      const bundle = await buildBundleFixture(f.root, {
        bundlePrewarm: 1,
        workerSource:
          mode === "prewarm fallback"
            ? `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(f.workspaceDir, "source.txt"))}, "changed by prewarm");`
            : "export {};",
      });
      const packageRoot = path.join(f.root, "runtime-package");
      const archive = path.join(
        packageRoot,
        "worker-artifacts",
        `${bundle.input.archive.sha256}.tgz`,
      );
      await fs.mkdir(path.dirname(archive), { recursive: true });
      await fs.writeFile(archive, bundle.archive);
      vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockReturnValue(packageRoot);
      if (mode === "snapshot fast path") {
        await preparePackagedNodeWorkerBundle(bundle.input);
      }
      await f.runtime.prepare(f.registration);
      const capture = vi.spyOn(workspaceCommands, "captureManifest");
      const installer = new NodeWorkerBundleInstaller({ root: path.join(f.root, "installer") });
      const replies: unknown[] = [];
      await handleInvoke(
        {
          id: "bundle",
          nodeId: "node",
          command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
          paramsJSON: JSON.stringify({ ...bundle.input, initialSnapshot: "checkpoint-fresh" }),
        },
        replyClient(replies),
        { current: async () => [] },
        undefined,
        {
          workerWorkspace: f.runtime,
          workerBundleInstaller: installer,
          gatewayUrl: "http://127.0.0.1:1",
        },
      );
      expect(replies).toContainEqual(expect.objectContaining({ ok: true }));
      const bound = f.runtime.prepare({
        ...binding,
        initialSnapshot: {
          checkpointId: "checkpoint-fresh",
          baseCommit: f.baseCommit,
          sourceManifestRef: f.registration.sourceManifestRef,
          preparedManifestRef: f.registration.preparedManifestRef,
        },
      });
      if (mode === "prewarm fallback") {
        expect(await fs.readFile(path.join(f.workspaceDir, "source.txt"), "utf8")).toBe(
          "changed by prewarm",
        );
        await expect(bound).rejects.toThrow("does not match its manifest");
      } else {
        await expect(bound).resolves.toMatchObject({ workspaceDir: f.workspaceDir });
        expect(capture).not.toHaveBeenCalled();
      }
    },
  );
});
