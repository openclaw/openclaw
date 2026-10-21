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
const scratch = () => tempDirs.make("openclaw-archive-guard-");
function tree(files: Record<string, string> = {}) {
  const root = scratch();
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}
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
}

function rejectArchive(archive: string, message: string, limits: readonly string[] = []) {
  const destination = `${archive}-output`;
  expectFailure(
    ["extract-zstd", archive, destination, "--allowed-root", "candidate", ...limits],
    message,
  );
  expect(existsSync(destination)).toBe(false);
}

function compressTar(tarPath: string): string {
  const archivePath = `${tarPath}.zst`;
  const zstdResult = spawnSync("zstd", ["-q", "-f", tarPath, "-o", archivePath], {
    encoding: "utf8",
  });
  expect(zstdResult.status, zstdResult.stderr).toBe(0);
  return archivePath;
}

type ArchiveMember = {
  name: string;
  content?: string;
  type?: "DIRTYPE" | "LNKTYPE" | "SYMTYPE";
  linkname?: string;
  pax_headers?: Record<string, string>;
};

function makeTarArchive(
  name: string,
  members: ArchiveMember[],
  format: "USTAR_FORMAT" | "PAX_FORMAT" | "GNU_FORMAT" = "USTAR_FORMAT",
): string {
  const tarPath = path.join(scratch(), `${name}.tar`);
  const python = String.raw`
import io
import json
import sys
import tarfile

with tarfile.open(sys.argv[1], "w", format=getattr(tarfile, sys.argv[3])) as archive:
    manifest = tarfile.TarInfo("manifest.json")
    manifest_payload = b'{"version":1}\n'
    manifest.size = len(manifest_payload)
    archive.addfile(manifest, io.BytesIO(manifest_payload))

    root = tarfile.TarInfo("candidate")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)
    for spec in json.loads(sys.argv[2]):
        member = tarfile.TarInfo(spec["name"])
        payload = spec.get("content", "").encode()
        member.size = len(payload)
        if "type" in spec:
            member.type = getattr(tarfile, spec["type"])
        member.linkname = spec.get("linkname", "")
        member.pax_headers = spec.get("pax_headers", {})
        archive.addfile(member, io.BytesIO(payload))
`;
  const result = spawnSync(
    pythonExecPath,
    ["-c", python, tarPath, JSON.stringify(members), format],
    {
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return compressTar(tarPath);
}

function makeCompressedArchive(fileSize = 32): string {
  return makeTarArchive("candidate", [
    { name: "candidate/payload.bin", content: "a".repeat(fileSize) },
  ]);
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
  kind: "gnu-longname" | "pax" | "pax-global",
  size: number,
): string {
  const tarPath = path.join(scratch(), `${kind}.tar`);
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

function makeLongMetadataArchive(kind: "gnu-longname" | "pax-path" | "symlink"): string {
  const longValue = "a".repeat(4097);
  return makeTarArchive(
    `${kind}-metadata`,
    [
      kind === "symlink"
        ? { name: "candidate/symlink", type: "SYMTYPE", linkname: longValue }
        : { name: `candidate/${longValue}`, content: "x" },
    ],
    kind === "gnu-longname" ? "GNU_FORMAT" : "PAX_FORMAT",
  );
}

function makeCumulativePaxArchive(): string {
  return makeTarArchive(
    "cumulative-pax",
    Array.from({ length: 5 }, (_, index) => ({
      name: `candidate/pax-${index}`,
      pax_headers: { comment: "x".repeat(400) },
    })),
    "PAX_FORMAT",
  );
}

function makeValidHardlinkArchive(): string {
  return makeTarArchive("valid-hardlink", [
    { name: "candidate/a-target.txt", content: "shared\n" },
    { name: "candidate/b-link.txt", type: "LNKTYPE", linkname: "candidate/a-target.txt" },
  ]);
}

describe("release Telegram candidate archive guard", () => {
  it("is executable and accepts an internal symlink", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const root = tree({ "target/value.txt": "ok\n" });
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
    const container = tree({ "outside.txt": "outside\n" });
    const root = path.join(container, "root");
    mkdirSync(root);
    symlinkSync("../outside.txt", path.join(root, "escape"));

    expectFailure(["validate-tree", root], "escaping symlink");
  });

  it("rejects a symlink supplied as the tree root", () => {
    const container = tree({ "target/value.txt": "outside\n" });
    const root = path.join(container, "root-link");
    symlinkSync("target", root);

    expectFailure(["validate-tree", root], "tree root must not be a symlink");
  });

  it("rejects a dangling symlink", () => {
    const root = scratch();
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
    const root = tree({ "sparse.bin": "" });
    const sparsePath = path.join(root, "sparse.bin");
    truncateSync(sparsePath, 2 * 1024 * 1024);

    expectFailure(
      ["validate-tree", root, "--max-apparent-bytes", `${1024 * 1024}`],
      "apparent size exceeds",
    );
  });

  it("rejects a tree over the entry-count cap", () => {
    const root = tree({ "one.txt": "one\n", "two.txt": "two\n" });

    expectFailure(["validate-tree", root, "--max-entries", "1"], "entry count exceeds 1");
  });

  it("rejects a same-device hard link whose other name is outside the tree", () => {
    const container = tree({ "outside.txt": "outside\n" });
    const root = path.join(container, "root");
    const outside = path.join(container, "outside.txt");
    mkdirSync(root);
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
    const archive = makeTarArchive("missing-parent", [
      { name: "candidate/missing/child.txt", content: "ok" },
    ]);
    rejectArchive(archive, "archive member parent is not a prior directory");
  });

  it.each([
    [
      "expanded size exceeds",
      4096,
      ["--max-expanded-bytes", "1024", "--max-stream-bytes", `${1024 * 1024}`],
    ],
    ["member count exceeds 2", 32, ["--max-members", "2"]],
    ["path metadata exceeds 10 bytes", 32, ["--max-path-bytes", "10"]],
    [
      "decompressed archive stream exceeds",
      32,
      ["--max-expanded-bytes", `${1024 * 1024}`, "--max-stream-bytes", "1024"],
    ],
  ] as const)("rejects archives when %s and cleans up", (message, fileSize, limits) => {
    rejectArchive(makeCompressedArchive(fileSize), message, limits);
  });

  it("extracts a prior-target hard link without retaining TarInfo records", () => {
    const archive = makeValidHardlinkArchive();
    const destination = `${archive}-output`;

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

  it.each(["pax", "gnu-longname", "pax-global"] as const)(
    "rejects a declared %s extension before reading its payload",
    (kind) => {
      rejectArchive(
        makeDeclaredExtensionArchive(kind, 4096),
        kind === "pax-global"
          ? "unsupported global PAX header"
          : "extension payload exceeds 1024 bytes",
        kind === "pax-global" ? [] : ["--max-extension-bytes", "1024"],
      );
    },
  );

  it("rejects archives over the cumulative extension payload cap", () => {
    rejectArchive(makeCumulativePaxArchive(), "extension payload total exceeds 2048 bytes", [
      "--max-extension-bytes",
      "1024",
      "--max-extension-total-bytes",
      "2048",
    ]);
  });

  it.each(["pax-path", "gnu-longname", "symlink"] as const)(
    "rejects an overlong %s path value",
    (kind) => {
      rejectArchive(makeLongMetadataArchive(kind), "exceeds 4096 bytes");
    },
  );

  it("rejects a hard link from the candidate tree to the manifest", () => {
    const archive = makeTarArchive("manifest-hardlink", [
      { name: "candidate/manifest-copy.json", type: "LNKTYPE", linkname: "manifest.json" },
    ]);
    rejectArchive(archive, "hard link target leaves candidate root");
  });

  it("rejects a link that replaces a previously extracted descendant directory", () => {
    const archive = makeTarArchive("link-prefix", [
      { name: "candidate/prefix", type: "DIRTYPE" },
      { name: "candidate/prefix/file.txt", content: "ok" },
      { name: "candidate/prefix", type: "SYMTYPE", linkname: "file.txt" },
    ]);
    rejectArchive(archive, "archive has duplicate path");
  });

  it("rejects a member nested under a prior link", () => {
    const archive = makeTarArchive("link-parent", [
      { name: "candidate/link", type: "SYMTYPE", linkname: "target" },
      { name: "candidate/link/child.txt", content: "ok" },
    ]);
    rejectArchive(archive, "path traverses a non-directory member");
  });

  it("rejects sparse archive members before extraction", () => {
    const archive = makeTarArchive(
      "sparse",
      [
        {
          name: "candidate/sparse.bin",
          content: "x",
          pax_headers: {
            "GNU.sparse.map": "0,1",
            "GNU.sparse.realsize": "2097152",
          },
        },
      ],
      "PAX_FORMAT",
    );
    rejectArchive(archive, "unsupported sparse member");
  });

  it("rejects a concatenated zstd frame after the tar payload", () => {
    const archive = makeCompressedArchive();
    const trailerPath = `${archive}-trailer.txt`;
    writeFileSync(trailerPath, "EXFILTRATED-CONCATENATED-FRAME");
    appendFileSync(archive, readFileSync(compressTar(trailerPath)));
    rejectArchive(archive, "non-zero data after tar end");
  });
});
