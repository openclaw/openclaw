import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGatewayRuntimeSnapshotStatus,
  pruneGatewayRuntimeSnapshots,
  resolveGatewayRuntimeSnapshotServiceCommand,
  rollbackGatewayRuntimeSnapshot,
} from "./gateway-runtime-snapshot.js";

const tempDirs: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createSourceCheckoutRoot(prefix = "openclaw-runtime-snapshot-") {
  const root = makeTempRoot(prefix);
  writeFile(path.join(root, ".git"), "gitdir: /tmp/fake.git\n");
  writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "openclaw" })}\n`);
  writeFile(path.join(root, "dist", "index.js"), "console.log('repo dist');\n");
  return root;
}

function createSnapshot(root: string, releaseId = "20260514T000000Z-test") {
  const snapshotRoot = path.join(
    root,
    ".artifacts",
    "openclaw-gateway-runtime",
    "releases",
    releaseId,
  );
  writeFile(path.join(snapshotRoot, "dist", "index.js"), "console.log('snapshot');\n");
  writeFile(path.join(snapshotRoot, "dist", "entry.js"), "console.log('entry');\n");
  writeFile(path.join(snapshotRoot, "dist", "control-ui", "index.html"), "<!doctype html>\n");
  writeFile(
    path.join(snapshotRoot, "dist-runtime", "extensions", "discord", "package.json"),
    "{}\n",
  );
  writeFile(
    path.join(snapshotRoot, "snapshot.json"),
    `${JSON.stringify({
      version: 1,
      releaseId,
      root: snapshotRoot,
      createdAt: "2026-05-14T00:00:00.000Z",
      paths: {
        entrypoint: path.join(snapshotRoot, "dist", "index.js"),
        controlUi: path.join(snapshotRoot, "dist", "control-ui"),
        bundledPlugins: path.join(snapshotRoot, "dist-runtime", "extensions"),
      },
    })}\n`,
  );
  writeFile(
    path.join(root, ".artifacts", "openclaw-gateway-runtime", "latest.json"),
    `${JSON.stringify({ version: 1, root: snapshotRoot })}\n`,
  );
  return snapshotRoot;
}

function snapshotReleaseRoot(root: string, releaseId: string): string {
  return path.join(root, ".artifacts", "openclaw-gateway-runtime", "releases", releaseId);
}

function setSnapshotCreatedAt(root: string, releaseId: string, createdAt: string) {
  const snapshotPath = path.join(snapshotReleaseRoot(root, releaseId), "snapshot.json");
  const existing = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  writeFile(snapshotPath, `${JSON.stringify({ ...existing, createdAt }, null, 2)}\n`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveGatewayRuntimeSnapshotServiceCommand", () => {
  it("points source-checkout gateway services at the latest promoted snapshot", () => {
    const root = createSourceCheckoutRoot();
    const snapshotRoot = createSnapshot(root);

    const result = resolveGatewayRuntimeSnapshotServiceCommand({
      cwd: root,
      programArguments: ["node", path.join(root, "dist", "index.js"), "gateway", "--port", "18789"],
    });

    expect(result.programArguments).toEqual([
      "node",
      path.join(snapshotRoot, "dist", "index.js"),
      "gateway",
      "--port",
      "18789",
    ]);
    expect(result.environment).toEqual({
      OPENCLAW_RUNTIME_SNAPSHOT_ROOT: snapshotRoot,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(snapshotRoot, "dist-runtime", "extensions"),
    });
  });

  it("leaves wrapper-based services unchanged", () => {
    const root = createSourceCheckoutRoot();
    createSnapshot(root);

    const result = resolveGatewayRuntimeSnapshotServiceCommand({
      cwd: root,
      programArguments: [path.join(root, "service-wrapper.sh"), "gateway", "--port", "18789"],
    });

    expect(result.programArguments).toEqual([
      path.join(root, "service-wrapper.sh"),
      "gateway",
      "--port",
      "18789",
    ]);
    expect(result.environment).toEqual({});
  });

  it("updates older package-local snapshot services to the latest promoted release", () => {
    const root = createSourceCheckoutRoot();
    const snapshotRoot = createSnapshot(root);
    const oldEntrypoint = path.join(
      root,
      ".artifacts",
      "openclaw-gateway-runtime",
      "current",
      "dist",
      "index.js",
    );
    writeFile(oldEntrypoint, "console.log('old mutable snapshot');\n");

    const result = resolveGatewayRuntimeSnapshotServiceCommand({
      cwd: root,
      programArguments: ["node", oldEntrypoint, "gateway", "--port", "18789"],
    });

    expect(result.programArguments).toEqual([
      "node",
      path.join(snapshotRoot, "dist", "index.js"),
      "gateway",
      "--port",
      "18789",
    ]);
    expect(result.environment).toEqual({
      OPENCLAW_RUNTIME_SNAPSHOT_ROOT: snapshotRoot,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(snapshotRoot, "dist-runtime", "extensions"),
    });
  });

  it("rejects snapshots outside the package-local releases directory", () => {
    const root = createSourceCheckoutRoot();
    const outsideRoot = makeTempRoot("openclaw-runtime-snapshot-outside-");
    writeFile(path.join(outsideRoot, "dist", "index.js"), "console.log('outside');\n");
    writeFile(path.join(outsideRoot, "dist", "control-ui", "index.html"), "<!doctype html>\n");
    writeFile(
      path.join(outsideRoot, "dist-runtime", "extensions", "discord", "package.json"),
      "{}\n",
    );
    writeFile(
      path.join(root, ".artifacts", "openclaw-gateway-runtime", "latest.json"),
      `${JSON.stringify({ version: 1, root: outsideRoot })}\n`,
    );

    const result = resolveGatewayRuntimeSnapshotServiceCommand({
      cwd: root,
      programArguments: ["node", path.join(root, "dist", "index.js"), "gateway"],
    });

    expect(result.programArguments).toEqual([
      "node",
      path.join(root, "dist", "index.js"),
      "gateway",
    ]);
    expect(result.environment).toEqual({});
  });

  it("does not use incomplete snapshots", () => {
    const root = createSourceCheckoutRoot();
    const snapshotRoot = path.join(
      root,
      ".artifacts",
      "openclaw-gateway-runtime",
      "releases",
      "incomplete",
    );
    writeFile(path.join(snapshotRoot, "dist", "index.js"), "console.log('incomplete');\n");
    writeFile(
      path.join(root, ".artifacts", "openclaw-gateway-runtime", "latest.json"),
      `${JSON.stringify({ version: 1, root: snapshotRoot })}\n`,
    );

    const result = resolveGatewayRuntimeSnapshotServiceCommand({
      cwd: root,
      programArguments: ["node", path.join(root, "dist", "index.js"), "gateway"],
    });

    expect(result.programArguments).toEqual([
      "node",
      path.join(root, "dist", "index.js"),
      "gateway",
    ]);
    expect(result.environment).toEqual({});
  });
});

describe("Gateway runtime snapshot management", () => {
  it("reports release status with latest, protected, and usable markers", () => {
    const root = createSourceCheckoutRoot();
    createSnapshot(root, "release-a");
    createSnapshot(root, "release-b");

    const status = getGatewayRuntimeSnapshotStatus({
      rootDir: root,
      includeSize: true,
      protectedRoots: [snapshotReleaseRoot(root, "release-a")],
    });

    expect(status.latestReleaseId).toBe("release-b");
    expect(status.releaseCount).toBe(2);
    expect(status.totalBytes).toBeGreaterThan(0);
    expect(status.releases.find((release) => release.releaseId === "release-a")).toMatchObject({
      protected: true,
      usable: true,
    });
    expect(status.releases.find((release) => release.releaseId === "release-b")).toMatchObject({
      latest: true,
      protected: true,
      usable: true,
    });
  });

  it("prunes older unprotected releases while keeping newest and protected releases", () => {
    const root = createSourceCheckoutRoot();
    createSnapshot(root, "release-a");
    setSnapshotCreatedAt(root, "release-a", "2026-05-14T00:00:00.000Z");
    createSnapshot(root, "release-b");
    setSnapshotCreatedAt(root, "release-b", "2026-05-14T00:01:00.000Z");
    createSnapshot(root, "release-c");
    setSnapshotCreatedAt(root, "release-c", "2026-05-14T00:02:00.000Z");
    createSnapshot(root, "release-d");
    setSnapshotCreatedAt(root, "release-d", "2026-05-14T00:03:00.000Z");

    const result = pruneGatewayRuntimeSnapshots({
      rootDir: root,
      env: { OPENCLAW_GATEWAY_RUNTIME_SNAPSHOT_KEEP: "2" },
      protectedRoots: [snapshotReleaseRoot(root, "release-a")],
    });

    expect(result.pruned.map((release) => release.releaseId)).toEqual(["release-b"]);
    expect(fs.existsSync(snapshotReleaseRoot(root, "release-a"))).toBe(true);
    expect(fs.existsSync(snapshotReleaseRoot(root, "release-b"))).toBe(false);
    expect(fs.existsSync(snapshotReleaseRoot(root, "release-c"))).toBe(true);
    expect(fs.existsSync(snapshotReleaseRoot(root, "release-d"))).toBe(true);
  });

  it("rolls latest back to a complete retained release", () => {
    const root = createSourceCheckoutRoot();
    const firstSnapshot = createSnapshot(root, "release-a");
    createSnapshot(root, "release-b");

    const result = rollbackGatewayRuntimeSnapshot({ rootDir: root, releaseId: "release-a" });
    const status = getGatewayRuntimeSnapshotStatus({ rootDir: root });

    expect(result).toMatchObject({ rolledBack: true, releaseId: "release-a" });
    expect(status.latestReleaseId).toBe("release-a");
    expect(status.latestRoot).toBe(firstSnapshot);
  });
});
