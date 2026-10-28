import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const loadManifestMetadataSnapshot = vi.hoisted(() => vi.fn());
vi.mock("./manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot,
}));

import { resolveSuggestedWorkerProfile } from "./worker-profile-suggestions.js";

describe("worker profile discovery public artifact", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-profile-discovery-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(root, "index.js"), 'throw new Error("runtime must stay lazy");\n');
    fs.writeFileSync(
      path.join(root, "worker-profile-api.js"),
      'export async function discoverWorkerProfile({ refresh }) { return { id: "cloud", profile: { provider: "fixture", settings: { refreshed: refresh === true } } }; }\n',
    );
    loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            rootDir: root,
            source: path.join(root, "index.js"),
            origin: "bundled",
            activation: { onStartup: false },
            contracts: { workerProviders: ["fixture"], workerProfileSuggestions: ["fixture"] },
          },
        ],
      }),
    );
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("loads only the declared discovery artifact before any profile exists", async () => {
    expect(await resolveSuggestedWorkerProfile({ config: {} })).toEqual({
      id: "cloud",
      profile: { provider: "fixture", settings: { refreshed: false } },
    });
    expect(await resolveSuggestedWorkerProfile({ config: {}, refresh: true })).toEqual({
      id: "cloud",
      profile: { provider: "fixture", settings: { refreshed: true } },
    });
  });

  it("does not offer a suggestion when an explicit profile exists", async () => {
    expect(
      await resolveSuggestedWorkerProfile({
        config: {
          cloudWorkers: { profiles: { custom: { provider: "fixture" } } },
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    { plugins: { enabled: false } },
    { plugins: { entries: { fixture: { enabled: false } } } },
    { plugins: { deny: ["fixture"] } },
    { plugins: { allow: ["other"] } },
  ] satisfies OpenClawConfig[])("respects disabled discovery owners: %j", async (config) => {
    expect(await resolveSuggestedWorkerProfile({ config })).toBeUndefined();
  });
});
