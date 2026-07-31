// Hook transform reload tests protect module caching and generation handoff.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  applyHookMappings,
  commitHookTransformMappingReload,
  resolveHookMappings,
} from "./hooks-mapping.js";

const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

function acceptHookMappings(mappings: ReturnType<typeof resolveHookMappings>) {
  commitHookTransformMappingReload();
  return mappings;
}

function createTransformMapping(params: {
  configDir: string;
  moduleName: string;
  path?: string;
  exportName?: string;
}) {
  const pathLocal = params.path ?? "reloadable";
  return resolveHookMappings(
    {
      mappings: [
        {
          match: { path: pathLocal },
          action: "agent",
          messageTemplate: "unused",
          transform: {
            module: params.moduleName,
            ...(params.exportName ? { export: params.exportName } : {}),
          },
        },
      ],
    },
    { configDir: params.configDir },
  );
}

function applyMappings(mappings: ReturnType<typeof resolveHookMappings>, pathLocal: string) {
  return applyHookMappings(mappings, {
    payload: {},
    headers: {},
    url: new URL(`http://127.0.0.1:18789/hooks/${pathLocal}`),
    path: pathLocal,
  });
}

async function waitForFile(filePath: string) {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(10);
  }
}

describe("hook transform reloads", () => {
  it("caches transform functions by module path and export name", async () => {
    const configDir = autoCleanupTempDirs.make("openclaw-hooks-export-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(transformsRoot, "multi-export.mjs"),
      [
        'export function transformA() { return { kind: "wake", text: "from-A" }; }',
        'export function transformB() { return { kind: "wake", text: "from-B" }; }',
      ].join("\n"),
    );

    const resultA = await applyMappings(
      createTransformMapping({
        configDir,
        moduleName: "multi-export.mjs",
        path: "testA",
        exportName: "transformA",
      }),
      "testA",
    );
    const resultB = await applyMappings(
      createTransformMapping({
        configDir,
        moduleName: "multi-export.mjs",
        path: "testB",
        exportName: "transformB",
      }),
      "testB",
    );

    expect(resultA?.ok).toBe(true);
    if (resultA?.ok && resultA.action?.kind === "wake") {
      expect(resultA.action.text).toBe("from-A");
    }
    expect(resultB?.ok).toBe(true);
    if (resultB?.ok && resultB.action?.kind === "wake") {
      expect(resultB.action.text).toBe("from-B");
    }
  });

  it("uses one transform module instance per mapping reload", async () => {
    const configDir = autoCleanupTempDirs.make("openclaw-hooks-generation-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(transformsRoot, "same-generation.mjs"),
      [
        "globalThis.__openclawHookTransformInstance = (globalThis.__openclawHookTransformInstance ?? 0) + 1;",
        "const instance = globalThis.__openclawHookTransformInstance;",
        'export function transformA() { return { kind: "wake", text: `A-${instance}` }; }',
        'export function transformB() { return { kind: "wake", text: `B-${instance}` }; }',
      ].join("\n"),
    );
    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "testA" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "same-generation.mjs", export: "transformA" },
          },
          {
            match: { path: "testB" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "same-generation.mjs", export: "transformB" },
          },
        ],
      },
      { configDir },
    );

    const resultA = await applyMappings(mappings, "testA");
    const resultB = await applyMappings(mappings, "testB");
    expect(resultA?.ok).toBe(true);
    expect(resultB?.ok).toBe(true);
    let instanceA: string | undefined;
    let instanceB: string | undefined;
    if (resultA?.ok && resultA.action?.kind === "wake") {
      instanceA = resultA.action.text.match(/^A-(.+)$/)?.[1];
    }
    if (resultB?.ok && resultB.action?.kind === "wake") {
      instanceB = resultB.action.text.match(/^B-(.+)$/)?.[1];
    }
    expect(instanceA).toBeDefined();
    expect(instanceB).toBe(instanceA);
  });

  it("reloads a transform when the module file changes", async () => {
    const configDir = autoCleanupTempDirs.make("openclaw-hooks-reload-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "reloadable.mjs");
    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "before" });');
    const resolveMappings = () =>
      createTransformMapping({ configDir, moduleName: "reloadable.mjs" });

    let acceptedMappings = acceptHookMappings(resolveMappings());
    const first = await applyMappings(acceptedMappings, "reloadable");
    expect(first?.ok).toBe(true);
    if (first?.ok && first.action?.kind === "wake") {
      expect(first.action.text).toBe("before");
    }

    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "after" });');
    const nextTime = new Date(Date.now() + 5_000);
    fs.utimesSync(modPath, nextTime, nextTime);
    acceptedMappings = acceptHookMappings(resolveMappings());
    const second = await applyMappings(acceptedMappings, "reloadable");
    expect(second?.ok).toBe(true);
    if (second?.ok && second.action?.kind === "wake") {
      expect(second.action.text).toBe("after");
    }
  });

  it("does not invalidate the active transform cache while resolving a rejected reload", async () => {
    const configDir = autoCleanupTempDirs.make("openclaw-hooks-rejected-reload-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "reloadable.mjs");
    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "accepted" });');
    const resolveMappings = () =>
      createTransformMapping({ configDir, moduleName: "reloadable.mjs" });

    const acceptedMappings = acceptHookMappings(resolveMappings());
    const accepted = await applyMappings(acceptedMappings, "reloadable");
    expect(accepted?.ok).toBe(true);
    if (accepted?.ok && accepted.action?.kind === "wake") {
      expect(accepted.action.text).toBe("accepted");
    }

    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "candidate" });');
    const nextTime = new Date(Date.now() + 5_000);
    fs.utimesSync(modPath, nextTime, nextTime);
    const rejectedCandidateMappings = resolveMappings();
    expect(rejectedCandidateMappings).toHaveLength(1);

    const stillAccepted = await applyMappings(acceptedMappings, "reloadable");
    expect(stillAccepted?.ok).toBe(true);
    if (stillAccepted?.ok && stillAccepted.action?.kind === "wake") {
      expect(stillAccepted.action.text).toBe("accepted");
    }
    const newlyAccepted = await applyMappings(
      acceptHookMappings(rejectedCandidateMappings),
      "reloadable",
    );
    expect(newlyAccepted?.ok).toBe(true);
    if (newlyAccepted?.ok && newlyAccepted.action?.kind === "wake") {
      expect(newlyAccepted.action.text).toBe("candidate");
    }
  });

  it("does not let an older in-flight transform import repopulate the reload cache", async () => {
    const configDir = autoCleanupTempDirs.make("openclaw-hooks-overlap-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "reloadable.mjs");
    const oldStartedPath = path.join(configDir, "old-started");
    const releaseOldPath = path.join(configDir, "release-old");
    fs.writeFileSync(
      modPath,
      [
        'import fs from "node:fs";',
        'import { setTimeout as delay } from "node:timers/promises";',
        `fs.writeFileSync(${JSON.stringify(oldStartedPath)}, "started");`,
        `while (!fs.existsSync(${JSON.stringify(releaseOldPath)})) { await delay(10); }`,
        'export default () => ({ kind: "wake", text: "old" });',
      ].join("\n"),
    );
    const resolveMappings = () =>
      createTransformMapping({ configDir, moduleName: "reloadable.mjs" });

    let acceptedMappings = acceptHookMappings(resolveMappings());
    const oldImport = applyMappings(acceptedMappings, "reloadable");
    await waitForFile(oldStartedPath);

    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "new" });');
    const nextTime = new Date(Date.now() + 5_000);
    fs.utimesSync(modPath, nextTime, nextTime);
    acceptedMappings = acceptHookMappings(resolveMappings());
    const afterReload = await applyMappings(acceptedMappings, "reloadable");
    expect(afterReload?.ok).toBe(true);
    if (afterReload?.ok && afterReload.action?.kind === "wake") {
      expect(afterReload.action.text).toBe("new");
    }

    fs.writeFileSync(releaseOldPath, "go");
    const olderResult = await oldImport;
    expect(olderResult?.ok).toBe(true);
    if (olderResult?.ok && olderResult.action?.kind === "wake") {
      expect(olderResult.action.text).toBe("old");
    }
    const final = await applyMappings(acceptedMappings, "reloadable");
    expect(final?.ok).toBe(true);
    if (final?.ok && final.action?.kind === "wake") {
      expect(final.action.text).toBe("new");
    }
  });
});
