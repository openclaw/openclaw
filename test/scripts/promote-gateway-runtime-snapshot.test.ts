import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGatewayRuntimeSnapshotStatus,
  pruneGatewayRuntimeSnapshots,
  promoteGatewayRuntimeSnapshot,
  rollbackGatewayRuntimeSnapshot,
  shouldPromoteGatewayRuntimeSnapshot,
} from "../../scripts/promote-gateway-runtime-snapshot.mjs";

const tempDirs: string[] = [];

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createSourceCheckoutBuild() {
  const root = makeRoot("openclaw-promote-runtime-snapshot-");
  writeFile(path.join(root, ".git"), "gitdir: /tmp/fake.git\n");
  writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  writeFile(path.join(root, "dist", "index.js"), "console.log('gateway');\n");
  writeFile(path.join(root, "dist", "entry.js"), "console.log('entry');\n");
  writeFile(path.join(root, "dist", "build-info.json"), '{"version":"2026.5.8"}\n');
  writeFile(path.join(root, "dist", "control-ui", "index.html"), "<!doctype html>\n");
  writeFile(path.join(root, "dist", ".buildstamp"), '{"head":"abc"}\n');
  writeFile(path.join(root, "dist-runtime", "extensions", "discord", "package.json"), "{}\n");
  return root;
}

function releaseRoot(root: string, releaseId: string): string {
  return path.join(root, ".artifacts", "openclaw-gateway-runtime", "releases", releaseId);
}

function latestPath(root: string): string {
  return path.join(root, ".artifacts", "openclaw-gateway-runtime", "latest.json");
}

function setSnapshotCreatedAt(root: string, releaseId: string, createdAt: string) {
  const snapshotPath = path.join(releaseRoot(root, releaseId), "snapshot.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(
    snapshotPath,
    `${JSON.stringify({ ...snapshot, createdAt }, null, 2)}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("promoteGatewayRuntimeSnapshot", () => {
  it("promotes a local source checkout build into a versioned runtime release", () => {
    const root = createSourceCheckoutBuild();

    const result = promoteGatewayRuntimeSnapshot({
      rootDir: root,
      env: {},
      releaseId: "release-a",
      now: new Date("2026-05-14T00:00:00Z"),
      pid: 123,
    });

    expect(result.promoted).toBe(true);
    const promotedReleaseRoot = releaseRoot(root, "release-a");
    expect(fs.existsSync(path.join(promotedReleaseRoot, "dist", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(promotedReleaseRoot, "dist", "control-ui", "index.html"))).toBe(
      true,
    );
    expect(
      fs.existsSync(
        path.join(promotedReleaseRoot, "dist-runtime", "extensions", "discord", "package.json"),
      ),
    ).toBe(true);
    const latest = JSON.parse(fs.readFileSync(latestPath(root), "utf8")) as { root?: string };
    expect(latest.root).toBe(promotedReleaseRoot);
  });

  it("copies recent Control UI JS and CSS assets into new snapshots for stale PWA shells", () => {
    const root = createSourceCheckoutBuild();
    writeFile(path.join(root, "dist", "control-ui", "assets", "index-old.js"), "old-js\n");
    writeFile(path.join(root, "dist", "control-ui", "assets", "chat-old.css"), "old-css\n");
    writeFile(path.join(root, "dist", "control-ui", "assets", "index-old.js.map"), "{}\n");

    promoteGatewayRuntimeSnapshot({
      rootDir: root,
      env: {},
      releaseId: "release-old",
      prune: false,
    });

    fs.rmSync(path.join(root, "dist", "control-ui", "assets"), { recursive: true, force: true });
    writeFile(path.join(root, "dist", "control-ui", "assets", "index-new.js"), "new-js\n");

    const result = promoteGatewayRuntimeSnapshot({
      rootDir: root,
      env: {},
      releaseId: "release-new",
      prune: false,
    });
    const promotedReleaseRoot = releaseRoot(root, "release-new");
    const latest = JSON.parse(fs.readFileSync(latestPath(root), "utf8")) as {
      source?: {
        controlUiCompatibilityAssets?: { copied?: number; releases?: string[] };
      };
    };

    expect(result.promoted).toBe(true);
    expect(
      fs.readFileSync(
        path.join(promotedReleaseRoot, "dist", "control-ui", "assets", "index-new.js"),
        "utf8",
      ),
    ).toBe("new-js\n");
    expect(
      fs.readFileSync(
        path.join(promotedReleaseRoot, "dist", "control-ui", "assets", "index-old.js"),
        "utf8",
      ),
    ).toBe("old-js\n");
    expect(
      fs.readFileSync(
        path.join(promotedReleaseRoot, "dist", "control-ui", "assets", "chat-old.css"),
        "utf8",
      ),
    ).toBe("old-css\n");
    expect(
      fs.existsSync(
        path.join(promotedReleaseRoot, "dist", "control-ui", "assets", "index-old.js.map"),
      ),
    ).toBe(false);
    expect(latest.source?.controlUiCompatibilityAssets).toMatchObject({
      copied: 2,
      releases: ["release-old"],
    });
  });

  it("skips CI unless snapshot promotion is explicitly requested", () => {
    const root = createSourceCheckoutBuild();

    expect(shouldPromoteGatewayRuntimeSnapshot({ rootDir: root, env: { CI: "true" } })).toEqual({
      promote: false,
      reason: "ci",
    });
    expect(
      shouldPromoteGatewayRuntimeSnapshot({
        rootDir: root,
        env: { CI: "true", OPENCLAW_GATEWAY_RUNTIME_SNAPSHOT: "1" },
      }),
    ).toEqual({ promote: true });
  });

  it("fails before publishing latest when required build outputs are missing", () => {
    const root = createSourceCheckoutBuild();
    fs.rmSync(path.join(root, "dist", "control-ui"), { recursive: true, force: true });

    expect(() =>
      promoteGatewayRuntimeSnapshot({
        rootDir: root,
        env: {},
        releaseId: "missing-ui",
      }),
    ).toThrow("missing Control UI assets");
    expect(fs.existsSync(latestPath(root))).toBe(false);
  });

  it("fails before publishing latest when the runtime build has no usable version", () => {
    const root = createSourceCheckoutBuild();
    fs.writeFileSync(path.join(root, "dist", "build-info.json"), '{"version":"0.0.0"}\n', "utf8");

    expect(() =>
      promoteGatewayRuntimeSnapshot({
        rootDir: root,
        env: {},
        releaseId: "bad-version",
      }),
    ).toThrow("dist/build-info.json has no usable OpenClaw version");
    expect(fs.existsSync(latestPath(root))).toBe(false);
    expect(fs.existsSync(releaseRoot(root, "bad-version"))).toBe(false);
  });

  it("prunes older unprotected releases while retaining latest and protected releases", () => {
    const root = createSourceCheckoutBuild();
    const releases = [
      ["release-a", "2026-05-14T00:00:00.000Z"],
      ["release-b", "2026-05-14T00:01:00.000Z"],
      ["release-c", "2026-05-14T00:02:00.000Z"],
      ["release-d", "2026-05-14T00:03:00.000Z"],
    ] as const;

    for (const [releaseId, createdAt] of releases) {
      promoteGatewayRuntimeSnapshot({
        rootDir: root,
        env: {},
        releaseId,
        prune: false,
      });
      setSnapshotCreatedAt(root, releaseId, createdAt);
    }

    const result = pruneGatewayRuntimeSnapshots({
      rootDir: root,
      env: { OPENCLAW_GATEWAY_RUNTIME_SNAPSHOT_KEEP: "2" },
      protectedRoots: [releaseRoot(root, "release-a")],
    });

    expect(result.pruned.map((release) => release.releaseId)).toEqual(["release-b"]);
    expect(fs.existsSync(releaseRoot(root, "release-a"))).toBe(true);
    expect(fs.existsSync(releaseRoot(root, "release-b"))).toBe(false);
    expect(fs.existsSync(releaseRoot(root, "release-c"))).toBe(true);
    expect(fs.existsSync(releaseRoot(root, "release-d"))).toBe(true);
  });

  it("reports latest, protected, usable, and size status for retained releases", () => {
    const root = createSourceCheckoutBuild();
    promoteGatewayRuntimeSnapshot({ rootDir: root, env: {}, releaseId: "release-a", prune: false });
    promoteGatewayRuntimeSnapshot({ rootDir: root, env: {}, releaseId: "release-b", prune: false });

    const status = getGatewayRuntimeSnapshotStatus({
      rootDir: root,
      includeSize: true,
      protectedRoots: [releaseRoot(root, "release-a")],
    });

    expect(status.releaseCount).toBe(2);
    expect(status.latestReleaseId).toBe("release-b");
    expect(status.totalBytes).toBeGreaterThan(0);
    expect(status.releases.find((release) => release.releaseId === "release-a")).toMatchObject({
      protected: true,
      usable: true,
    });
    expect(status.releases.find((release) => release.releaseId === "release-b")).toMatchObject({
      latest: true,
      usable: true,
    });
  });

  it("rolls latest back to a validated retained release", () => {
    const root = createSourceCheckoutBuild();
    promoteGatewayRuntimeSnapshot({ rootDir: root, env: {}, releaseId: "release-a", prune: false });
    promoteGatewayRuntimeSnapshot({ rootDir: root, env: {}, releaseId: "release-b", prune: false });

    const result = rollbackGatewayRuntimeSnapshot({ rootDir: root, releaseId: "release-a" });
    const latest = JSON.parse(fs.readFileSync(latestPath(root), "utf8")) as {
      releaseId?: string;
      root?: string;
    };

    expect(result).toMatchObject({ rolledBack: true, releaseId: "release-a" });
    expect(latest.releaseId).toBe("release-a");
    expect(latest.root).toBe(releaseRoot(root, "release-a"));
  });
});
