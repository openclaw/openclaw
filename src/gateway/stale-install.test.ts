import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
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

async function registerRunHandoff(
  accept: () => void,
  waitForUpdates: () => Promise<void> | undefined = () => undefined,
) {
  const { registerGatewayRunInstallationReplacement } =
    await import("../cli/gateway-cli/run-loop-request.js");
  dispose = registerGatewayRunInstallationReplacement({
    waitForUpdates,
    accept,
    logger: { warn: vi.fn(), error: vi.fn() },
    supervised: true,
  });
}

beforeEach(async () => {
  resetGatewayWorkAdmission();
  fixture.root = directories.make("openclaw-replaced-install-");
  fixture.buildId = "build-before";
  await fs.mkdir(path.join(fixture.root, "dist"));
  vi.resetModules();
  owner = await import("./stale-install.js");
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe("running installation replacement", () => {
  it.each(["rebuild", "package swap", "source-only"] as const)(
    "observes %s metadata",
    async (kind) => {
      fixture.buildId = kind === "source-only" ? null : "build-before";
      const version = kind === "rebuild" ? "2026.9.4" : "2026.9.5";
      const handoff = vi.fn();
      dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
      if (kind === "package swap") {
        for (const metadata of [
          undefined,
          '{"version":',
          JSON.stringify({ version, buildId: "" }),
        ]) {
          if (metadata !== undefined) {
            await fs.writeFile(path.join(fixture.root, "dist", "build-info.json"), metadata);
          }
          await owner.checkGatewayInstallationReplacement();
        }
      } else if (kind === "rebuild") {
        await writeIdentity(version, "build-before");
        await owner.checkGatewayInstallationReplacement();
      }
      expect(owner.getGatewayInstallationReplacement()).toBeUndefined();
      expect(handoff).not.toHaveBeenCalled();
      await writeIdentity(version, "build-after");
      await Promise.all([
        owner.checkGatewayInstallationReplacement(),
        owner.checkGatewayInstallationReplacement(),
      ]);
      if (kind === "source-only") {
        expect(handoff).not.toHaveBeenCalled();
        return;
      }
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

  it("follows a replaced stable pnpm link after the running version directory is removed", async () => {
    const globalRoot = fixture.root;
    const stableRoot = path.join(globalRoot, "node_modules", "openclaw");
    const packageRoot = (version: string) =>
      path.join(
        globalRoot,
        "node_modules",
        ".pnpm",
        `openclaw@${version}`,
        "node_modules",
        "openclaw",
      );
    fixture.root = packageRoot("2026.9.4");
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
    fixture.root = packageRoot("2026.9.5");
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

  it("leaves installation handoff with the suspension owner from preparation until rollback", async () => {
    const restart = vi.fn();
    await registerRunHandoff(restart);
    const suspension = tryBeginGatewaySuspendAdmission(vi.fn());
    expect(suspension).not.toBeNull();
    await writeIdentity("2026.9.5", "build-after");
    await owner.checkGatewayInstallationReplacement();
    expect(restart).not.toHaveBeenCalled();
    expect(owner.getGatewayInstallationReplacement()).toBeUndefined();
    expect(suspension?.rollback()).toBe(true);
    await owner.checkGatewayInstallationReplacement();
    expect(restart).toHaveBeenCalledOnce();
  });

  it.each(["replacement", "rollback"] as const)(
    "rechecks %s after a suspended helper settles",
    async (outcome) => {
      const helper = createDeferredCore();
      const accepted = createDeferredCore();
      const restart = vi.fn(() => accepted.resolve());
      await registerRunHandoff(restart, vi.fn().mockReturnValueOnce(helper.promise));
      await writeIdentity("2026.9.5", "build-after");
      await owner.checkGatewayInstallationReplacement();
      const suspension = tryBeginGatewaySuspendAdmission(vi.fn());
      expect(suspension?.drain()).toBe(true);
      if (outcome === "rollback") {
        await writeIdentity("2026.9.4", "build-before");
      }
      helper.resolve();
      await helper.promise;
      expect(restart).not.toHaveBeenCalled();
      expect(suspension?.release()).toBe(true);
      await owner.checkGatewayInstallationReplacement();
      if (outcome === "replacement") {
        await accepted.promise;
        expect(restart).toHaveBeenCalledOnce();
      } else {
        expect(restart).not.toHaveBeenCalled();
        expect(owner.getGatewayInstallationReplacement()).toBeUndefined();
      }
    },
  );

  it.each(["suspension", "registration"] as const)(
    "coalesces reads and discards observations after %s changes",
    async (change) => {
      const json = await import("../infra/json-files.js");
      const pending = createDeferredCore<unknown>();
      const read = vi.spyOn(json, "tryReadJson").mockImplementationOnce(() => pending.promise);
      const restart = vi.fn();
      dispose = owner.registerGatewayInstallationReplacementHandler(restart);
      const currentHandoff = vi.fn();
      const checking = Promise.all([
        owner.checkGatewayInstallationReplacement(),
        owner.checkGatewayInstallationReplacement(),
      ]);
      expect(read).toHaveBeenCalledOnce();
      try {
        if (change === "suspension") {
          const suspension = tryBeginGatewaySuspendAdmission(vi.fn());
          expect(suspension?.drain()).toBe(true);
          await writeIdentity("2026.9.4", "build-before");
          expect(suspension?.release()).toBe(true);
        } else {
          dispose();
          dispose = owner.registerGatewayInstallationReplacementHandler(currentHandoff);
        }
        pending.resolve({ version: "2026.9.5", buildId: "build-after" });
        await checking;
        expect(restart).not.toHaveBeenCalled();
        expect(currentHandoff).not.toHaveBeenCalled();
        expect(owner.getGatewayInstallationReplacement()).toBeUndefined();
        if (change === "suspension") {
          await owner.checkGatewayInstallationReplacement();
          expect(restart).not.toHaveBeenCalled();
        }
      } finally {
        pending.resolve(undefined);
        await checking;
      }
    },
  );

  it("reports missing runtime chunks without taking over a held suspension", () => {
    const restart = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(restart);
    const suspension = tryBeginGatewaySuspendAdmission(vi.fn());
    expect(suspension?.drain()).toBe(true);
    const missing = Object.assign(new Error("runtime chunk unavailable"), {
      code: "ENOENT",
      path: path.join(fixture.root, "dist", "runtime.js"),
    });
    expect(owner.classifyGatewayStaleInstall(missing)?.error.details).toMatchObject({
      code: "STALE_INSTALL",
    });
    expect(restart).not.toHaveBeenCalled();
    expect(owner.getGatewayInstallationReplacement()).toBeUndefined();
    expect(suspension?.release()).toBe(true);
    expect(owner.classifyGatewayStaleInstall(missing)).not.toBeNull();
    expect(restart).toHaveBeenCalledOnce();
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

  it("attributes an export mismatch only after a replacement is recorded, and names both builds", async () => {
    // Node reports this one as a bare SyntaxError with no code, url, or path: an
    // already-loaded chunk linking against a package whose exports moved.
    const exportMismatch = () =>
      new SyntaxError(
        "The requested module '@openclaw/fs-safe/advanced' does not provide an export named 'copyFileDescriptorSync'",
      );
    const handoff = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
    // Indistinguishable from a source bug while the installation still matches.
    expect(owner.classifyGatewayStaleInstall(exportMismatch())).toBeNull();

    await writeIdentity("2026.9.5", "build-after");
    await owner.checkGatewayInstallationReplacement();
    expect(handoff).toHaveBeenCalledOnce();

    const classified = owner.classifyGatewayStaleInstall(
      new Error("Runtime load failed", { cause: exportMismatch() }),
    );
    expect(classified?.error.details).toMatchObject({
      code: "STALE_INSTALL",
      runningBuildId: "build-before",
      onDiskBuildId: "build-after",
    });
    expect(classified?.error.message).toContain(
      "running 2026.9.4 build build-before; on-disk 2026.9.5 build build-after",
    );
    expect(classified?.error.message).toContain(classified?.restartCommand ?? "");
  });

  it("annotates a missing chunk with the running build even when the on-disk identity is unreadable", () => {
    const handoff = vi.fn();
    dispose = owner.registerGatewayInstallationReplacementHandler(handoff);
    const classified = owner.classifyGatewayStaleInstall(
      Object.assign(new Error("chunk unavailable"), {
        code: "ENOENT",
        path: path.join(fixture.root, "dist", "subagent-registry-old.mjs"),
      }),
    );
    expect(classified?.error.details).toMatchObject({
      code: "STALE_INSTALL",
      runningBuildId: "build-before",
      onDiskBuildId: null,
    });
    expect(classified?.error.message).toContain("on-disk runtime chunks unavailable");
  });
});
