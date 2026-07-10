import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/release-telegram-candidate-archive.py");
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "openclaw-archive-guard-"));
  tempDirs.push(directory);
  return directory;
}

function runHelper(args: string[]) {
  return spawnSync("python3", [SCRIPT, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function expectSuccess(args: string[]) {
  const result = runHelper(args);
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function expectFailure(args: string[], message: string) {
  const result = runHelper(args);
  expect(result.status, result.stdout).toBe(1);
  expect(result.stderr).toContain(message);
  return result;
}

function makeCompressedArchive(root: string, fileSize = 32): string {
  const source = path.join(root, "source");
  const candidate = path.join(source, "candidate");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(path.join(source, "manifest.json"), '{"version":1}\n');
  writeFileSync(path.join(candidate, "payload.bin"), Buffer.alloc(fileSize, 0x61));

  const tarPath = path.join(root, "candidate.tar");
  const archivePath = `${tarPath}.zst`;
  const tarResult = spawnSync("tar", ["-cf", tarPath, "-C", source, "manifest.json", "candidate"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(tarResult.status, tarResult.stderr).toBe(0);
  const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archivePath], {
    encoding: "utf8",
  });
  expect(zstdResult.status, zstdResult.stderr).toBe(0);
  return archivePath;
}

describe("release Telegram candidate archive guard", () => {
  it("is executable and accepts an internal symlink", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const root = makeTempDir();
    mkdirSync(path.join(root, "target"));
    writeFileSync(path.join(root, "target", "value.txt"), "ok\n");
    symlinkSync("target/value.txt", path.join(root, "internal-link"));

    const result = expectSuccess([
      "validate-tree",
      root,
      "--max-entries",
      "10",
      "--max-apparent-bytes",
      "1024",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ entries: 3 });
  });

  it("rejects an escaping symlink", () => {
    const container = makeTempDir();
    const root = path.join(container, "root");
    mkdirSync(root);
    writeFileSync(path.join(container, "outside.txt"), "outside\n");
    symlinkSync("../outside.txt", path.join(root, "escape"));

    expectFailure(["validate-tree", root], "escaping symlink");
  });

  it("rejects a symlink supplied as the tree root", () => {
    const container = makeTempDir();
    const target = path.join(container, "target");
    const root = path.join(container, "root-link");
    mkdirSync(target);
    writeFileSync(path.join(target, "value.txt"), "outside\n");
    symlinkSync("target", root);

    expectFailure(["validate-tree", root], "tree root must not be a symlink");
  });

  it("rejects a dangling symlink", () => {
    const root = makeTempDir();
    symlinkSync("missing.txt", path.join(root, "dangling"));

    expectFailure(["validate-tree", root], "dangling symlink");
  });

  it("rejects a socket entry", async () => {
    const root = makeTempDir();
    const socketPath = path.join(root, "candidate.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      expectFailure(["validate-tree", root], "unsupported special entry");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses apparent size when rejecting a sparse file", () => {
    const root = makeTempDir();
    const sparsePath = path.join(root, "sparse.bin");
    writeFileSync(sparsePath, "");
    truncateSync(sparsePath, 2 * 1024 * 1024);

    expectFailure(
      ["validate-tree", root, "--max-apparent-bytes", `${1024 * 1024}`],
      "apparent size exceeds",
    );
  });

  it("rejects a tree over the entry-count cap", () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "one.txt"), "one\n");
    writeFileSync(path.join(root, "two.txt"), "two\n");

    expectFailure(["validate-tree", root, "--max-entries", "1"], "entry count exceeds 1");
  });

  it("rejects a same-device hard link whose other name is outside the tree", () => {
    const container = makeTempDir();
    const root = path.join(container, "root");
    const outside = path.join(container, "outside.txt");
    mkdirSync(root);
    writeFileSync(outside, "outside\n");
    linkSync(outside, path.join(root, "linked.txt"));

    expectFailure(["validate-tree", root], "hard links outside the validated root");
  });

  it("accepts hard links whose complete link set is inside the tree", () => {
    const root = makeTempDir();
    const first = path.join(root, "first.txt");
    writeFileSync(first, "shared\n");
    linkSync(first, path.join(root, "second.txt"));

    const result = expectSuccess(["validate-tree", root]);
    expect(JSON.parse(result.stdout)).toMatchObject({ entries: 2 });
  });

  it("streams and extracts a valid compressed archive", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const destination = path.join(root, "extracted");

    const result = expectSuccess([
      "extract-zstd",
      archive,
      destination,
      "--allowed-root",
      "candidate",
      "--max-members",
      "10",
      "--max-expanded-bytes",
      "4096",
      "--max-stream-bytes",
      `${1024 * 1024}`,
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      allowedRoot: "candidate",
      members: 3,
    });
    expect(existsSync(path.join(destination, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(destination, "candidate", "payload.bin"))).toBe(true);
    expect(statSync(destination).mode & 0o777).toBe(0o700);
  });

  it("rejects compressed archives over the expanded-size cap and cleans up", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root, 4096);
    const destination = path.join(root, "expanded-limit");

    expectFailure(
      [
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
        "--max-expanded-bytes",
        "1024",
        "--max-stream-bytes",
        `${1024 * 1024}`,
      ],
      "expanded size exceeds",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects compressed archives over the member-count cap and cleans up", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const destination = path.join(root, "member-limit");

    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate", "--max-members", "2"],
      "member count exceeds 2",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a hard link from the candidate tree to the manifest", () => {
    const root = makeTempDir();
    const source = path.join(root, "source-hardlink");
    const candidate = path.join(source, "candidate");
    mkdirSync(candidate, { recursive: true });
    const manifest = path.join(source, "manifest.json");
    writeFileSync(manifest, '{"version":1}\n');
    linkSync(manifest, path.join(candidate, "manifest-copy.json"));

    const tarPath = path.join(root, "hardlink.tar");
    const archivePath = `${tarPath}.zst`;
    const tarResult = spawnSync(
      "tar",
      ["-cf", tarPath, "-C", source, "manifest.json", "candidate"],
      {
        encoding: "utf8",
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      },
    );
    expect(tarResult.status, tarResult.stderr).toBe(0);
    const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archivePath], {
      encoding: "utf8",
    });
    expect(zstdResult.status, zstdResult.stderr).toBe(0);

    expectFailure(
      [
        "extract-zstd",
        archivePath,
        path.join(root, "hardlink-output"),
        "--allowed-root",
        "candidate",
      ],
      "hard link target leaves candidate root",
    );
  });

  it("rejects sparse archive members before extraction", () => {
    const root = makeTempDir();
    const tarPath = path.join(root, "sparse.tar");
    const archivePath = `${tarPath}.zst`;
    const python = String.raw`
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.PAX_FORMAT) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    sparse = tarfile.TarInfo("candidate/sparse.bin")
    sparse.size = 1
    sparse.pax_headers = {
        "GNU.sparse.map": "0,1",
        "GNU.sparse.realsize": "2097152",
    }
    archive.addfile(sparse, io.BytesIO(b"x"))
`;
    const tarResult = spawnSync("python3", ["-c", python, tarPath], {
      encoding: "utf8",
    });
    expect(tarResult.status, tarResult.stderr).toBe(0);
    const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archivePath], {
      encoding: "utf8",
    });
    expect(zstdResult.status, zstdResult.stderr).toBe(0);

    expectFailure(
      [
        "extract-zstd",
        archivePath,
        path.join(root, "sparse-output"),
        "--allowed-root",
        "candidate",
      ],
      "unsupported sparse member",
    );
  });

  it("rejects compressed archives over the stream cap and cleans up", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const destination = path.join(root, "stream-limit");

    expectFailure(
      [
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
        "--max-expanded-bytes",
        `${1024 * 1024}`,
        "--max-stream-bytes",
        "1024",
      ],
      "decompressed archive stream exceeds",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects non-zero bytes after the tar end marker", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const tarPath = archive.slice(0, -".zst".length);
    appendFileSync(tarPath, "EXFILTRATED-TRAILER");
    const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archive], {
      encoding: "utf8",
    });
    expect(zstdResult.status, zstdResult.stderr).toBe(0);

    const destination = path.join(root, "trailing-output");
    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
      "non-zero data after tar end",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a concatenated zstd frame after the tar payload", () => {
    const root = makeTempDir();
    const archive = makeCompressedArchive(root);
    const trailerPath = path.join(root, "trailer.txt");
    const trailerArchive = `${trailerPath}.zst`;
    writeFileSync(trailerPath, "EXFILTRATED-CONCATENATED-FRAME");
    const zstdResult = spawnSync("zstd", ["-q", "-f", trailerPath, "-o", trailerArchive], {
      encoding: "utf8",
    });
    expect(zstdResult.status, zstdResult.stderr).toBe(0);
    appendFileSync(archive, readFileSync(trailerArchive));

    const destination = path.join(root, "concatenated-output");
    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
      "non-zero data after tar end",
    );
    expect(existsSync(destination)).toBe(false);
  });
});
