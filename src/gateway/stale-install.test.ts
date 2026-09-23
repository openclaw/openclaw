import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";

const fixture = vi.hoisted(() => ({ root: "", buildId: "build-before" as string | null }));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRootSync: () => fixture.root,
}));
vi.mock("../version.js", () => ({
  VERSION: "2026.9.4",
  resolveRuntimeServiceBuildId: () => fixture.buildId,
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
let owner: typeof import("./stale-install.js");
let dispose: (() => void) | undefined;

async function writeIdentity(version: string, buildId: string): Promise<void> {
  await fs.writeFile(
    path.join(fixture.root, "dist", "build-info.json"),
    JSON.stringify({ version, buildId }),
  );
}

beforeEach(async () => {
  fixture.root = directories.make("openclaw-replaced-install-");
  fixture.buildId = "build-before";
  await fs.mkdir(path.join(fixture.root, "dist"));
  vi.resetModules();
  owner = await import("./stale-install.js");
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

describe("running installation replacement", () => {
  it.each(["2026.9.4", "2026.9.5"])(
    "records a changed artifact once, including a same-version rebuild (%s)",
    async (version) => {
      const handoff = vi.fn();
      dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
      await writeIdentity("2026.9.4", "build-before");
      await owner.checkGatewayInstallationReplacement();
      expect(handoff).not.toHaveBeenCalled();
      await writeIdentity(version, "build-after");
      await Promise.all([
        owner.checkGatewayInstallationReplacement(),
        owner.checkGatewayInstallationReplacement(),
      ]);
      expect(handoff).toHaveBeenCalledOnce();
      expect(owner.getGatewayInstallationReplacement()).toMatchObject({
        running: { version: "2026.9.4", buildId: "build-before" },
        onDisk: { version, buildId: "build-after" },
        reason: expect.stringContaining("gateway.installation_replaced"),
        message: expect.stringContaining(`${version} build build-after`),
      });
      await owner.checkGatewayInstallationReplacement();
      expect(handoff).toHaveBeenCalledOnce();
    },
  );

  it("waits through missing and malformed package-swap metadata without inventing a replacement", async () => {
    const handoff = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
    await owner.checkGatewayInstallationReplacement();
    await fs.writeFile(path.join(fixture.root, "dist", "build-info.json"), '{"version":');
    await owner.checkGatewayInstallationReplacement();
    await writeIdentity("2026.9.5", "");
    await owner.checkGatewayInstallationReplacement();
    expect(owner.getGatewayInstallationReplacement()).toBeUndefined();
    expect(handoff).not.toHaveBeenCalled();
    await writeIdentity("2026.9.5", "build-after");
    await owner.checkGatewayInstallationReplacement();
    expect(handoff).toHaveBeenCalledOnce();
  });

  it("does not mistake source-only package edits for a replaced running artifact", async () => {
    fixture.buildId = null;
    const handoff = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
    await writeIdentity("2026.9.5", "build-after");
    await owner.checkGatewayInstallationReplacement();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("follows a replaced stable pnpm link after the running version directory is removed", async () => {
    const globalRoot = fixture.root;
    const stableRoot = path.join(globalRoot, "node_modules", "openclaw");
    fixture.root = path.join(
      globalRoot,
      "node_modules",
      ".pnpm",
      "openclaw@2026.9.4",
      "node_modules",
      "openclaw",
    );
    await fs.mkdir(path.join(fixture.root, "dist"), { recursive: true });
    await fs.symlink(fixture.root, stableRoot, "junction");
    await writeIdentity("2026.9.4", "build-before");
    vi.resetModules();
    owner = await import("./stale-install.js");
    const handoff = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
    await owner.checkGatewayInstallationReplacement();
    expect(handoff).not.toHaveBeenCalled();
    const oldRoot = fixture.root;
    fixture.root = path.join(
      globalRoot,
      "node_modules",
      ".pnpm",
      "openclaw@2026.9.5",
      "node_modules",
      "openclaw",
    );
    await fs.mkdir(path.join(fixture.root, "dist"), { recursive: true });
    await writeIdentity("2026.9.5", "build-after");
    await fs.unlink(stableRoot);
    await fs.symlink(fixture.root, stableRoot, "junction");
    await fs.rm(oldRoot, { recursive: true });
    await owner.checkGatewayInstallationReplacement();
    expect(handoff).toHaveBeenCalledOnce();
    expect(owner.getGatewayInstallationReplacement()?.onDisk?.buildId).toBe("build-after");
  });

  it("keeps the registered Gateway root authoritative across duplicate SDK module copies", async () => {
    const handoff = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
    await writeIdentity("2026.9.5", "build-after");
    fixture.root = directories.make("openclaw-copied-sdk-");
    vi.resetModules();
    const copiedModule = await import("./stale-install.js");
    await copiedModule.checkGatewayInstallationReplacement();
    expect(handoff).toHaveBeenCalledOnce();
    expect(copiedModule.getGatewayInstallationReplacement()?.onDisk?.buildId).toBe("build-after");
  });

  it("coalesces disk reads and rejects an observation after its lifecycle registration retires", async () => {
    const json = await import("../infra/json-files.js");
    const pending = createDeferredCore<unknown>();
    const read = vi.spyOn(json, "tryReadJson").mockImplementationOnce(() => pending.promise);
    const retiredHandoff = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(retiredHandoff);
    const first = owner.checkGatewayInstallationReplacement();
    const second = owner.checkGatewayInstallationReplacement();
    expect(read).toHaveBeenCalledOnce();
    dispose();
    const currentHandoff = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(currentHandoff);
    pending.resolve({ version: "2026.9.5", buildId: "build-after" });
    await Promise.all([first, second]);
    expect(retiredHandoff).not.toHaveBeenCalled();
    expect(currentHandoff).not.toHaveBeenCalled();
    expect(owner.getGatewayInstallationReplacement()).toBeUndefined();
  });

  it.each(["ENOENT", "ERR_MODULE_NOT_FOUND"])(
    "uses the same handoff for a missing own chunk (%s), excluding dependencies and data",
    (code) => {
      const handoff = vi.fn();
      dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
      const missing = (relative: string) => {
        const missingPath = path.join(fixture.root, relative);
        return Object.assign(new Error("chunk unavailable"), {
          code,
          ...(code === "ENOENT" ? { path: missingPath } : { url: pathToFileURL(missingPath).href }),
        });
      };
      expect(owner.classifyGatewayStaleInstall(missing("dist/data.json"))).toBeNull();
      expect(owner.classifyGatewayStaleInstall(missing("node_modules/other/index.js"))).toBeNull();
      expect(handoff).not.toHaveBeenCalled();
      expect(
        owner.classifyGatewayStaleInstall(
          new Error("Runtime load failed", {
            cause: missing("dist/durable-delivery-old.js"),
          }),
        ),
      ).not.toBeNull();
      owner.classifyGatewayStaleInstall(missing("dist/cron-old.js"));
      expect(handoff).toHaveBeenCalledOnce();
      expect(owner.getGatewayInstallationReplacement()?.message).toContain(
        "runtime chunks unavailable",
      );
    },
  );
});
