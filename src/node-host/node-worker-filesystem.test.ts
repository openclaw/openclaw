import fs from "node:fs";
import path from "node:path";
import { prepareFilesystemRestrictedLaunch } from "@openclaw/proc-safe/filesystem-launch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as openclawRoot from "../infra/openclaw-root.js";
import * as temporaryDirectory from "../infra/tmp-openclaw-dir.js";
import { prepareNodeWorkerFilesystem } from "./node-worker-filesystem.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const root = tempDirs.make("worker-filesystem-grants-");
  const homeDir = path.join(root, "home");
  const bundleRoot = path.join(root, "bundles");
  const packageRoot = path.join(root, "runtime");
  const entryRoot = path.join(root, "entry");
  const sharedTemporaryRoot = path.join(root, "shared-tmp");
  for (const directory of [homeDir, bundleRoot, packageRoot, entryRoot, sharedTemporaryRoot]) {
    fs.mkdirSync(directory);
  }
  // External installation discovery and temp-root selection use this test-owned layout.
  vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockReturnValue(packageRoot);
  vi.spyOn(temporaryDirectory, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    sharedTemporaryRoot,
  );
  const env: NodeJS.ProcessEnv = { HOME: homeDir };
  const prepare = async (
    workspaceDir: string,
    capturedHome = homeDir,
    capturedBundleRoot = bundleRoot,
  ) => {
    const launch = await prepareNodeWorkerFilesystem({
      workspaceDir,
      bundleRoot: capturedBundleRoot,
      entry: path.join(entryRoot, "worker.mjs"),
      homeDir: capturedHome,
      env,
      args: ["-e", "process.exit(0)"],
    });
    await launch.cleanup();
    return launch;
  };
  return { root, homeDir, bundleRoot, packageRoot, entryRoot, sharedTemporaryRoot, env, prepare };
}

describe.runIf(process.platform === "linux")("node worker writable workspace grants", () => {
  it.each(["bundle", "home", "temporary"])(
    "rejects replaceable entries in the original %s root pathname",
    async (kind) => {
      const f = fixture();
      const workspace = path.join(f.root, "workspace");
      fs.mkdirSync(workspace);
      const alias = path.join(workspace, "trusted");
      // Temp selection can preserve an ordinary root beneath a symlinked ancestor.
      const target = kind === "bundle" ? f.bundleRoot : kind === "home" ? f.homeDir : f.root;
      fs.symlinkSync(target, alias);
      if (kind === "temporary") {
        vi.mocked(temporaryDirectory.resolvePreferredOpenClawTmpDir).mockReturnValue(
          path.join(alias, "shared-tmp"),
        );
      }
      await expect(
        f.prepare(
          workspace,
          kind === "home" ? alias : f.homeDir,
          kind === "bundle" ? alias : f.bundleRoot,
        ),
      ).rejects.toThrow(/Worker writable storage cannot/);
      expect(fs.readdirSync(f.sharedTemporaryRoot)).toEqual([]);
    },
  );

  it("rejects native helper storage outside the OpenClaw installation", async () => {
    const f = fixture();
    const launch = prepareFilesystemRestrictedLaunch({
      executable: process.execPath,
      readOnlyPaths: [],
      readWritePaths: [],
    });
    await expect(f.prepare(path.dirname(launch.command))).rejects.toThrow(
      /Worker writable storage cannot/,
    );
    expect(fs.readdirSync(f.sharedTemporaryRoot)).toEqual([]);
  });

  it.each([
    "node",
    "node-alias",
    "library",
    "system-bin",
    "local-bin",
    "entry",
    "runtime-child",
    "runtime-alias",
    "runtime-link",
    "shared-tmp",
    "tmp-parent",
    "tmp-alias",
    "captured-ca",
    "captured-ca-alias",
    "captured-ca-parent-alias",
    "captured-ca-target-alias",
    "captured-ca-dotdot-alias",
    "captured-ca-trailing-alias",
    "captured-ca-repeated-alias",
    "captured-ca-directory-dotdot",
  ])("rejects a workspace that exposes protected storage: %s", async (layout) => {
    const f = fixture();
    let workspace: string;
    switch (layout) {
      case "node":
        workspace = path.dirname(process.execPath);
        break;
      case "node-alias":
        workspace = path.join(f.root, "node-alias");
        fs.symlinkSync(path.dirname(process.execPath), workspace);
        break;
      case "library":
        workspace = "/usr/lib";
        break;
      case "system-bin":
        workspace = "/usr/sbin";
        break;
      case "local-bin":
        workspace = "/usr/local/bin";
        break;
      case "entry":
        workspace = f.entryRoot;
        break;
      case "runtime-child":
        workspace = path.join(f.packageRoot, "dist");
        fs.mkdirSync(workspace);
        break;
      case "runtime-alias": {
        workspace = path.join(f.root, "workspace");
        fs.mkdirSync(workspace);
        const alias = path.join(f.root, "runtime-alias");
        fs.symlinkSync(workspace, alias);
        vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockReturnValue(alias);
        break;
      }
      case "runtime-link":
        workspace = path.join(f.root, "workspace");
        fs.mkdirSync(workspace);
        fs.symlinkSync(f.packageRoot, path.join(workspace, "runtime"));
        vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockReturnValue(
          path.join(workspace, "runtime"),
        );
        break;
      case "shared-tmp":
        workspace = f.sharedTemporaryRoot;
        break;
      case "tmp-parent":
        workspace = path.join(f.root, "tmp-parent");
        fs.mkdirSync(workspace);
        fs.renameSync(f.sharedTemporaryRoot, path.join(workspace, "shared-tmp"));
        vi.mocked(temporaryDirectory.resolvePreferredOpenClawTmpDir).mockReturnValue(
          path.join(workspace, "shared-tmp"),
        );
        break;
      case "tmp-alias": {
        workspace = f.sharedTemporaryRoot;
        const alias = path.join(f.root, "tmp-alias");
        fs.symlinkSync(workspace, alias);
        vi.mocked(temporaryDirectory.resolvePreferredOpenClawTmpDir).mockReturnValue(alias);
        break;
      }
      case "captured-ca-alias":
      case "captured-ca-parent-alias":
      case "captured-ca-target-alias":
      case "captured-ca-dotdot-alias":
      case "captured-ca-trailing-alias":
      case "captured-ca-repeated-alias":
      case "captured-ca-directory-dotdot": {
        workspace = path.join(f.root, "workspace");
        fs.mkdirSync(workspace);
        const trustRoot = path.join(f.root, "trust");
        fs.mkdirSync(trustRoot);
        fs.writeFileSync(path.join(trustRoot, "ca.pem"), "test CA");
        if (layout === "captured-ca-directory-dotdot") {
          fs.mkdirSync(path.join(workspace, "step"));
          f.env.NODE_EXTRA_CA_CERTS = path.join(f.root, "ca-alias.pem");
          fs.symlinkSync("workspace/step/../../trust/ca.pem", f.env.NODE_EXTRA_CA_CERTS);
        } else if (layout === "captured-ca-repeated-alias") {
          fs.symlinkSync(trustRoot, path.join(workspace, "trust"));
          f.env.NODE_EXTRA_CA_CERTS = path.join(f.root, "ca-alias.pem");
          fs.symlinkSync("workspace/trust//ca.pem", f.env.NODE_EXTRA_CA_CERTS);
        } else if (layout === "captured-ca-trailing-alias") {
          fs.symlinkSync(trustRoot, path.join(workspace, "trust"));
          const alias = path.join(f.root, "trust-alias");
          fs.symlinkSync("workspace/trust/", alias);
          f.env.NODE_EXTRA_CA_CERTS = path.join(alias, "ca.pem");
        } else if (layout === "captured-ca-dotdot-alias") {
          fs.symlinkSync(trustRoot, path.join(workspace, "trust"));
          fs.writeFileSync(path.join(f.root, "ca.pem"), "test CA");
          fs.writeFileSync(path.join(workspace, "ca.pem"), "workspace CA");
          f.env.NODE_EXTRA_CA_CERTS = path.join(f.root, "ca-alias.pem");
          fs.symlinkSync("workspace/trust/../ca.pem", f.env.NODE_EXTRA_CA_CERTS);
        } else if (layout !== "captured-ca-parent-alias") {
          const alias = path.join(workspace, "ca.pem");
          fs.symlinkSync(path.join(trustRoot, "ca.pem"), alias);
          f.env.NODE_EXTRA_CA_CERTS = alias;
          if (layout === "captured-ca-target-alias") {
            f.env.NODE_EXTRA_CA_CERTS = path.join(f.root, "ca-alias.pem");
            fs.symlinkSync(path.relative(f.root, alias), f.env.NODE_EXTRA_CA_CERTS);
          }
        } else {
          fs.symlinkSync(trustRoot, path.join(workspace, "trust"));
          const workspaceAlias = path.join(f.root, "workspace-alias");
          fs.symlinkSync(workspace, workspaceAlias);
          f.env.NODE_EXTRA_CA_CERTS = path.join(workspaceAlias, "trust", "ca.pem");
        }
        break;
      }
      default:
        workspace = path.join(f.root, "workspace");
        fs.mkdirSync(workspace);
        f.env.NODE_EXTRA_CA_CERTS = path.join(workspace, "platform-ca.pem");
        fs.writeFileSync(f.env.NODE_EXTRA_CA_CERTS, "test CA");
    }
    await expect(f.prepare(workspace)).rejects.toThrow(/Worker writable storage cannot/);
  });

  it.each(["home", "scratch"])("rejects %s placed inside runtime code", async (layout) => {
    const f = fixture();
    const workspace = path.join(f.root, "workspace");
    fs.mkdirSync(workspace);
    if (layout === "scratch") {
      vi.mocked(temporaryDirectory.resolvePreferredOpenClawTmpDir).mockReturnValue(f.packageRoot);
    }
    await expect(
      f.prepare(workspace, layout === "home" ? f.packageRoot : f.homeDir),
    ).rejects.toThrow(/Worker writable storage cannot/);
    expect(fs.readdirSync(f.packageRoot)).toEqual([]);
  });

  it.each(["runtime-sibling", "tmp-child", "home-child", "ca-parent-traversal"])(
    "admits a workspace without granting its protected parents: %s",
    async (layout) => {
      const f = fixture();
      const workspace =
        layout === "ca-parent-traversal"
          ? path.join(f.root, "workspace")
          : layout === "runtime-sibling"
            ? `${f.packageRoot}-project`
            : path.join(layout === "tmp-child" ? f.sharedTemporaryRoot : f.homeDir, "project");
      fs.mkdirSync(workspace);
      if (layout === "ca-parent-traversal") {
        const trustRoot = path.join(f.root, "trust");
        fs.mkdirSync(trustRoot);
        fs.writeFileSync(path.join(trustRoot, "ca.pem"), "test CA");
        f.env.NODE_EXTRA_CA_CERTS = `${workspace}/../trust/ca.pem`;
      }
      await expect(f.prepare(workspace)).resolves.toBeDefined();
    },
  );

  it.skipIf(!fs.existsSync("/usr/src"))(
    "admits a project beneath the broad /usr read grant",
    async () => {
      const f = fixture();
      await expect(f.prepare("/usr/src")).resolves.toBeDefined();
    },
  );
});
