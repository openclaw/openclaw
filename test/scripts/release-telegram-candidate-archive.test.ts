import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("scripts/release-telegram-candidate-archive.py");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pythonExecPath = (() => {
  for (const candidate of [
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3",
    "python3",
  ]) {
    const probe = spawnSync(candidate, [
      "-c",
      'import tarfile; assert hasattr(tarfile, "data_filter") and hasattr(tarfile, "FilterError")',
    ]);
    if (probe.status === 0) {
      return candidate;
    }
  }
  throw new Error("release Telegram archive tests require Python with tarfile.data_filter");
})();
const tarVersion = spawnSync("tar", ["--version"], { encoding: "utf8" });
const hasGnuTar = tarVersion.status === 0 && tarVersion.stdout?.includes("GNU tar");

function runHelper(args: string[]) {
  return spawnSync(pythonExecPath, [SCRIPT, ...args], {
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

function compressTar(tarPath: string): string {
  const archivePath = `${tarPath}.zst`;
  const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archivePath], {
    encoding: "utf8",
  });
  expect(zstdResult.status, zstdResult.stderr).toBe(0);
  return archivePath;
}

function makeTarArchive(
  root: string,
  name: string,
  members: string,
  format: "USTAR_FORMAT" | "PAX_FORMAT" = "USTAR_FORMAT",
): string {
  const tarPath = path.join(root, `${name}.tar`);
  const python = `
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=tarfile.${format}) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)
${members}
`;
  const result = spawnSync(pythonExecPath, ["-c", python, tarPath], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeCompressedArchive(root: string, fileSize = 32): string {
  const source = path.join(root, "source");
  const candidate = path.join(source, "candidate");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(path.join(source, "manifest.json"), '{"version":1}\n');
  writeFileSync(path.join(candidate, "payload.bin"), Buffer.alloc(fileSize, 0x61));

  const tarPath = path.join(root, "candidate.tar");
  const tarResult = spawnSync("tar", ["-cf", tarPath, "-C", source, "manifest.json", "candidate"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(tarResult.status, tarResult.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeDepthFirstProducerArchive(root: string): string {
  const source = path.join(root, "depth-first-source");
  const candidate = path.join(source, "candidate");
  mkdirSync(path.join(candidate, "app"), { recursive: true });
  writeFileSync(path.join(source, "manifest.json"), '{"version":1}\n');
  writeFileSync(path.join(candidate, "app", "child"), "child\n");
  writeFileSync(path.join(candidate, "app-routes.ts"), "routes\n");

  const archivePath = path.join(root, "depth-first-producer.tar.zst");
  const script = String.raw`
set -euo pipefail
cd "$SOURCE"
LC_ALL=C tar \
  --create \
  --format=posix \
  --sort=name \
  --one-file-system \
  --numeric-owner \
  --owner=0 \
  --group=0 \
  --no-xattrs \
  --no-acls \
  --pax-option=delete=atime,delete=ctime \
  manifest.json \
  candidate |
zstd -T0 -3 -q -o "$ARCHIVE"
`;
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARCHIVE: archivePath,
      SOURCE: source,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return archivePath;
}

function makeDeclaredExtensionArchive(
  root: string,
  kind: "gnu-longname" | "pax" | "pax-global",
  size: number,
): string {
  const tarPath = path.join(root, `${kind}.tar`);
  const python = String.raw`
import sys
import tarfile

types = {
    "gnu-longname": tarfile.GNUTYPE_LONGNAME,
    "pax": tarfile.XHDTYPE,
    "pax-global": tarfile.XGLTYPE,
}
header = tarfile.TarInfo("././@PaxHeader")
header.type = types[sys.argv[2]]
header.size = int(sys.argv[3])
with open(sys.argv[1], "wb") as output:
    output.write(header.tobuf(format=tarfile.USTAR_FORMAT))
`;
  const result = spawnSync(pythonExecPath, ["-c", python, tarPath, kind, String(size)], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeLongMetadataArchive(
  root: string,
  kind: "gnu-longname" | "pax-path" | "symlink",
): string {
  const tarPath = path.join(root, `${kind}-metadata.tar`);
  const python = String.raw`
import io
import sys
import tarfile

kind = sys.argv[2]
archive_format = tarfile.GNU_FORMAT if kind == "gnu-longname" else tarfile.PAX_FORMAT
with tarfile.open(sys.argv[1], "w", format=archive_format) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)

    long_value = "a" * 4097
    if kind in {"gnu-longname", "pax-path"}:
        member = tarfile.TarInfo(f"candidate/{long_value}")
        member.size = 1
        archive.addfile(member, io.BytesIO(b"x"))
    else:
        member = tarfile.TarInfo(f"candidate/{kind}")
        member.type = tarfile.SYMTYPE
        member.linkname = long_value
        archive.addfile(member)
`;
  const result = spawnSync(pythonExecPath, ["-c", python, tarPath, kind], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeCumulativePaxArchive(root: string): string {
  return makeTarArchive(
    root,
    "cumulative-pax",
    String.raw`
    for index in range(5):
        member = tarfile.TarInfo(f"candidate/pax-{index}")
        member.pax_headers = {"comment": "x" * 400}
        archive.addfile(member)
`,
    "PAX_FORMAT",
  );
}

function makeValidHardlinkArchive(root: string): string {
  return makeTarArchive(
    root,
    "valid-hardlink",
    String.raw`
    target = tarfile.TarInfo("candidate/a-target.txt")
    target_payload = b"shared\n"
    target.size = len(target_payload)
    archive.addfile(target, io.BytesIO(target_payload))

    link = tarfile.TarInfo("candidate/b-link.txt")
    link.type = tarfile.LNKTYPE
    link.linkname = target.name
    archive.addfile(link)
`,
    "USTAR_FORMAT",
  );
}

describe("release Telegram candidate archive guard", () => {
  it("is executable and accepts an internal symlink", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const root = tempDirs.make("openclaw-archive-guard-");
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
    const container = tempDirs.make("openclaw-archive-guard-");
    const root = path.join(container, "root");
    mkdirSync(root);
    writeFileSync(path.join(container, "outside.txt"), "outside\n");
    symlinkSync("../outside.txt", path.join(root, "escape"));

    expectFailure(["validate-tree", root], "escaping symlink");
  });

  it("rejects a symlink supplied as the tree root", () => {
    const container = tempDirs.make("openclaw-archive-guard-");
    const target = path.join(container, "target");
    const root = path.join(container, "root-link");
    mkdirSync(target);
    writeFileSync(path.join(target, "value.txt"), "outside\n");
    symlinkSync("target", root);

    expectFailure(["validate-tree", root], "tree root must not be a symlink");
  });

  it("rejects a dangling symlink", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    symlinkSync("missing.txt", path.join(root, "dangling"));

    expectFailure(["validate-tree", root], "dangling symlink");
  });

  it("rejects a socket entry", async () => {
    // Keep the socket path below macOS's 104-byte sockaddr_un buffer.
    const root = tempDirs.make("sock-");
    const socketPath = path.join(root, "candidate.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      expectFailure(["validate-tree", root], "unsupported special entry");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("uses apparent size when rejecting a sparse file", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const sparsePath = path.join(root, "sparse.bin");
    writeFileSync(sparsePath, "");
    truncateSync(sparsePath, 2 * 1024 * 1024);

    expectFailure(
      ["validate-tree", root, "--max-apparent-bytes", `${1024 * 1024}`],
      "apparent size exceeds",
    );
  });

  it("rejects a tree over the entry-count cap", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    writeFileSync(path.join(root, "one.txt"), "one\n");
    writeFileSync(path.join(root, "two.txt"), "two\n");

    expectFailure(["validate-tree", root, "--max-entries", "1"], "entry count exceeds 1");
  });

  it("rejects a same-device hard link whose other name is outside the tree", () => {
    const container = tempDirs.make("openclaw-archive-guard-");
    const root = path.join(container, "root");
    const outside = path.join(container, "outside.txt");
    mkdirSync(root);
    writeFileSync(outside, "outside\n");
    linkSync(outside, path.join(root, "linked.txt"));

    expectFailure(["validate-tree", root], "hard links outside the validated root");
  });

  it.runIf(hasGnuTar)(
    "accepts the producer's depth-first order around punctuation siblings",
    () => {
      const root = tempDirs.make("openclaw-archive-guard-");
      const archive = makeDepthFirstProducerArchive(root);
      const listing = spawnSync("bash", ["-c", 'zstd -dc "$1" | tar -tf -', "bash", archive], {
        encoding: "utf8",
      });
      expect(listing.status, listing.stderr).toBe(0);
      expect(listing.stdout.trim().split("\n")).toEqual([
        "manifest.json",
        "candidate/",
        "candidate/app/",
        "candidate/app/child",
        "candidate/app-routes.ts",
      ]);

      const destination = path.join(root, "depth-first-producer-output");
      const result = expectSuccess([
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({ members: 5 });
      expect(JSON.parse(result.stdout).maxCachedMembers).toBeLessThanOrEqual(1);
      expect(readFileSync(path.join(destination, "candidate", "app-routes.ts"), "utf8")).toBe(
        "routes\n",
      );
      expect(readFileSync(path.join(destination, "candidate", "app", "child"), "utf8")).toBe(
        "child\n",
      );
    },
  );

  it("rejects a member whose parent directory was not declared first", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeTarArchive(
      root,
      "missing-parent",
      String.raw`
    child = tarfile.TarInfo("candidate/missing/child.txt")
    child.size = 2
    archive.addfile(child, io.BytesIO(b"ok"))
`,
      "USTAR_FORMAT",
    );
    const destination = path.join(root, "missing-parent-output");

    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
      "archive member parent is not a prior directory",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects compressed archives over the expanded-size cap and cleans up", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
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

  it("extracts a prior-target hard link without retaining TarInfo records", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeValidHardlinkArchive(root);
    const destination = path.join(root, "hardlink-success");

    const result = expectSuccess([
      "extract-zstd",
      archive,
      destination,
      "--allowed-root",
      "candidate",
    ]);
    expect(JSON.parse(result.stdout).maxCachedMembers).toBeLessThanOrEqual(1);
    expect(existsSync(path.join(destination, "manifest.json"))).toBe(true);
    expect(statSync(destination).mode & 0o777).toBe(0o700);
    const target = path.join(destination, "candidate", "a-target.txt");
    const link = path.join(destination, "candidate", "b-link.txt");
    expect(readFileSync(link, "utf8")).toBe("shared\n");
    expect(statSync(link).ino).toBe(statSync(target).ino);
  });

  it("rejects compressed archives over the member-count cap and cleans up", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeCompressedArchive(root);
    const destination = path.join(root, "member-limit");

    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate", "--max-members", "2"],
      "member count exceeds 2",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it.each(["pax", "gnu-longname"] as const)(
    "rejects a declared %s extension before reading its payload",
    (kind) => {
      const root = tempDirs.make("openclaw-archive-guard-");
      const archive = makeDeclaredExtensionArchive(root, kind, 4096);
      const destination = path.join(root, `${kind}-limit`);

      expectFailure(
        [
          "extract-zstd",
          archive,
          destination,
          "--allowed-root",
          "candidate",
          "--max-extension-bytes",
          "1024",
        ],
        "extension payload exceeds 1024 bytes",
      );
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("rejects a global PAX header before reading its payload", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeDeclaredExtensionArchive(root, "pax-global", 4096);
    const destination = path.join(root, "pax-global-limit");

    expectFailure(
      ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
      "unsupported global PAX header",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects archives over the cumulative extension payload cap", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeCumulativePaxArchive(root);
    const destination = path.join(root, "extension-total-limit");

    expectFailure(
      [
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
        "--max-extension-bytes",
        "1024",
        "--max-extension-total-bytes",
        "2048",
      ],
      "extension payload total exceeds 2048 bytes",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it.each(["pax-path", "gnu-longname", "symlink"] as const)(
    "rejects an overlong %s path value",
    (kind) => {
      const root = tempDirs.make("openclaw-archive-guard-");
      const archive = makeLongMetadataArchive(root, kind);
      const destination = path.join(root, `${kind}-path-limit`);

      expectFailure(
        ["extract-zstd", archive, destination, "--allowed-root", "candidate"],
        "exceeds 4096 bytes",
      );
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("rejects archives over the aggregate path metadata cap", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeCompressedArchive(root);
    const destination = path.join(root, "path-limit");

    expectFailure(
      [
        "extract-zstd",
        archive,
        destination,
        "--allowed-root",
        "candidate",
        "--max-path-bytes",
        "10",
      ],
      "path metadata exceeds 10 bytes",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a hard link from the candidate tree to the manifest", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
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

  it("rejects a link that replaces a previously extracted descendant directory", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeTarArchive(
      root,
      "link-prefix",
      String.raw`
    prefix = tarfile.TarInfo("candidate/prefix")
    prefix.type = tarfile.DIRTYPE
    archive.addfile(prefix)

    payload = tarfile.TarInfo("candidate/prefix/file.txt")
    payload.size = 2
    archive.addfile(payload, io.BytesIO(b"ok"))

    replacement = tarfile.TarInfo("candidate/prefix")
    replacement.type = tarfile.SYMTYPE
    replacement.linkname = "file.txt"
    archive.addfile(replacement)
`,
      "USTAR_FORMAT",
    );
    expectFailure(
      [
        "extract-zstd",
        archive,
        path.join(root, "link-prefix-output"),
        "--allowed-root",
        "candidate",
      ],
      "archive has duplicate path",
    );
  });

  it("rejects a member nested under a prior link", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeTarArchive(
      root,
      "link-parent",
      String.raw`
    link = tarfile.TarInfo("candidate/link")
    link.type = tarfile.SYMTYPE
    link.linkname = "target"
    archive.addfile(link)

    child = tarfile.TarInfo("candidate/link/child.txt")
    child.size = 2
    archive.addfile(child, io.BytesIO(b"ok"))
`,
      "USTAR_FORMAT",
    );
    expectFailure(
      [
        "extract-zstd",
        archive,
        path.join(root, "link-parent-output"),
        "--allowed-root",
        "candidate",
      ],
      "path traverses a non-directory member",
    );
  });

  it("rejects sparse archive members before extraction", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
    const archive = makeTarArchive(
      root,
      "sparse",
      String.raw`
    sparse = tarfile.TarInfo("candidate/sparse.bin")
    sparse.size = 1
    sparse.pax_headers = {
        "GNU.sparse.map": "0,1",
        "GNU.sparse.realsize": "2097152",
    }
    archive.addfile(sparse, io.BytesIO(b"x"))
`,
      "PAX_FORMAT",
    );
    expectFailure(
      ["extract-zstd", archive, path.join(root, "sparse-output"), "--allowed-root", "candidate"],
      "unsupported sparse member",
    );
  });

  it("rejects compressed archives over the stream cap and cleans up", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
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

  it("rejects a concatenated zstd frame after the tar payload", () => {
    const root = tempDirs.make("openclaw-archive-guard-");
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
