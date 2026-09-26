import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planMacNodeWorkerClosure } from "../../scripts/prune-mac-node-worker.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function write(root: string, relative: string, contents = ""): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function fixture(): string {
  const root = tempDirs.make("openclaw-mac-closure-");
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "openclaw",
      version: "1.2.3",
      type: "module",
      exports: { "./plugin-sdk/demo": "./dist/plugin-sdk/demo.js" },
      dependencies: {
        "@openclaw/ai": "1.0.0",
        alpha: "1.0.0",
        "partial-json": "1.0.0",
        undici: "1.0.0",
      },
      optionalDependencies: { "sqlite-vec": "1.0.0" },
    }),
  );
  write(
    root,
    "dist/mac-node-worker.js",
    'import "./worker-shared.mjs"; import "@openclaw/ai"; import "alpha/subpath"; import "path";',
  );
  write(
    root,
    "dist/worker-shared.mjs",
    'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); require.resolve("ws/package.json"); globalThis.runtimeProcessEntrypoints.serviceChildRelay; globalThis.runtimeProcessEntrypoints.gitOperations;',
  );
  write(root, "dist/build-info.json", "{}");
  write(root, "dist/plugin-sdk/demo.js", 'export * from "../sdk-shared.mjs";');
  write(root, "dist/sdk-shared.mjs", "export const sdk = true;");
  write(root, "dist/media/image-processor.worker.js", 'import "../image-worker-shared.mjs";');
  write(root, "dist/image-worker-shared.mjs", "export const imageWorker = true;");
  write(root, "dist/infra/sqlite-store.worker.js", 'import "../sqlite-worker-shared.mjs";');
  write(root, "dist/sqlite-worker-shared.mjs", "export const sqliteWorker = true;");
  write(
    root,
    "dist/process/supervisor/service-child-relay.js",
    'import "./relay-shared.mjs"; globalThis.runtimeProcessEntrypoints.serviceChildGroupAnchor;',
  );
  write(root, "dist/process/supervisor/relay-shared.mjs", "export const relay = true;");
  write(
    root,
    "dist/process/supervisor/service-child-group-anchor.js",
    'import "./anchor-shared.mjs";',
  );
  write(root, "dist/process/supervisor/anchor-shared.mjs", "export const anchor = true;");
  write(root, "dist/infra/git-operation.worker.js", 'import "./git-worker-shared.mjs";');
  write(root, "dist/infra/git-worker-shared.mjs", "export const gitWorker = true;");
  write(root, "node_modules/@openclaw/ai/package.json", '{"name":"@openclaw/ai"}');
  write(
    root,
    "node_modules/@openclaw/ai/dist/runtime.js",
    'import "partial-json"; import "undici"; import "fs";',
  );
  for (const [id, registration] of [
    ["browser", "export default { nodeHostCommands: [] };"],
    ["file-transfer", "api.registerNodeHostCommand({});"],
    [
      "cua-computer",
      'import { registerComputerUseProvider } from "openclaw/plugin-sdk/demo"; registerComputerUseProvider(api, {});',
    ],
  ]) {
    write(root, `dist/extensions/${id}/package.json`, JSON.stringify({ name: id }));
    write(root, `dist/extensions/${id}/openclaw.plugin.json`, JSON.stringify({ id }));
    write(
      root,
      `dist/extensions/${id}/index.js`,
      `import "openclaw/plugin-sdk/demo"; ${registration}`,
    );
  }
  write(root, "dist/extensions/unrelated/package.json", '{"name":"unrelated"}');
  write(root, "dist/extensions/unrelated/index.js", "export default {};");
  write(root, "dist/extensions/browser/setup-entry.js", 'import "./setup-runtime.js";');
  write(root, "dist/extensions/browser/setup-runtime.js", "export const setup = true;");
  write(root, "skills/system/SKILL.md", "# System");
  write(root, "dist/entry.js", "throw new Error('complete CLI');");
  write(root, "dist/control-ui/index.html", "unused");
  write(root, "dist/worker/worker.mjs", "unused");
  return root;
}

describe("Mac node worker closure", () => {
  it("retains worker, plugin SDK, bundled node plugins, and skills only", () => {
    const plan = planMacNodeWorkerClosure(fixture(), resolveTestNodeExecPath());
    expect(plan.dependencies).toEqual([
      "@openclaw/ai",
      "alpha",
      "partial-json",
      "sqlite-vec",
      "undici",
      "ws",
    ]);
    expect(plan.files).toContain("dist/mac-node-worker.js");
    expect(plan.files).toContain("dist/worker-shared.mjs");
    expect(plan.files).toContain("dist/plugin-sdk/demo.js");
    expect(plan.files).toContain("dist/sdk-shared.mjs");
    expect(plan.files).toContain("dist/extensions/browser/index.js");
    expect(plan.files).toContain("dist/extensions/browser/setup-entry.js");
    expect(plan.files).toContain("dist/extensions/browser/setup-runtime.js");
    expect(plan.files).toContain("dist/extensions/file-transfer/index.js");
    expect(plan.files).toContain("dist/extensions/cua-computer/index.js");
    expect(plan.files).toContain("dist/media/image-processor.worker.js");
    expect(plan.files).toContain("dist/image-worker-shared.mjs");
    expect(plan.files).toContain("dist/infra/sqlite-store.worker.js");
    expect(plan.files).toContain("dist/sqlite-worker-shared.mjs");
    expect(plan.files).toContain("dist/process/supervisor/service-child-relay.js");
    expect(plan.files).toContain("dist/process/supervisor/relay-shared.mjs");
    expect(plan.files).toContain("dist/process/supervisor/service-child-group-anchor.js");
    expect(plan.files).toContain("dist/process/supervisor/anchor-shared.mjs");
    expect(plan.files).toContain("dist/infra/git-operation.worker.js");
    expect(plan.files).toContain("dist/infra/git-worker-shared.mjs");
    expect(plan.files).not.toContain("dist/extensions/unrelated/index.js");
    expect(plan.files).toContain("skills/system/SKILL.md");
    expect(plan.files).not.toContain("dist/entry.js");
    expect(plan.files.some((file) => file.startsWith("dist/control-ui/"))).toBe(false);
    expect(plan.files.some((file) => file.startsWith("dist/worker/"))).toBe(false);
  });

  it("rejects a missing relative runtime edge", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "dist/mac-node-worker.js"), 'import "./missing.mjs";');
    expect(() => planMacNodeWorkerClosure(root, resolveTestNodeExecPath())).toThrow(
      "Mac worker closure seed is missing",
    );
  });
});
