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

function runPython(source: string, ...args: string[]) {
  const result = spawnSync(pythonExecPath, ["-c", source, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function extract(archive: string) {
  const destination = `${archive}-output`;
  const result = expectSuccess([
    "extract-zstd",
    archive,
    destination,
    "--allowed-root",
    "candidate",
  ]);
  const summary = JSON.parse(result.stdout);
  expect(summary.maxCachedMembers).toBeLessThanOrEqual(1);
  return { destination, summary };
}

type ArchiveMember = {
  name: string;
  content?: string;
  type?: "DIRTYPE" | "LNKTYPE" | "SYMTYPE";
  linkname?: string;
  pax_headers?: Record<string, string>;
};
const file = (name: string, content = "ok"): ArchiveMember => ({
  name: `candidate/${name}`,
  content,
});
const linkMember = (
  name: string,
  linkname: string,
  type: "LNKTYPE" | "SYMTYPE",
): ArchiveMember => ({
  name: `candidate/${name}`,
  linkname,
  type,
});

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
  runPython(python, tarPath, JSON.stringify(members), format);
  return compressTar(tarPath);
}

function makeDepthFirstProducerArchive(): string {
  const source = tree({
    "manifest.json": '{"version":1}\n',
    "candidate/app/child": "child\n",
    "candidate/app-routes.ts": "routes\n",
  });
  const archivePath = path.join(scratch(), "producer.tar.zst");
  const script = String.raw`
set -euo pipefail
cd "$SOURCE"
LC_ALL=C tar --create --format=posix --sort=name --one-file-system \
  --numeric-owner --owner=0 --group=0 --no-xattrs --no-acls \
  --pax-option=delete=atime,delete=ctime manifest.json candidate |
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
  runPython(python, tarPath, kind, String(size));
  return compressTar(tarPath);
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

  it.each([
    ["../outside.txt", "escaping symlink"],
    ["missing.txt", "dangling symlink"],
    ["root", "tree root must not be a symlink"],
  ])("rejects %s (%s)", (target, message) => {
    const container = tree({ "outside.txt": "outside\n", "root/value.txt": "ok\n" });
    const root = path.join(container, "root");
    const link = path.join(target === "root" ? container : root, "link");
    symlinkSync(target, link);
    expectFailure(["validate-tree", target === "root" ? link : root], message);
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
      const { destination, summary } = extract(makeDepthFirstProducerArchive());
      expect(summary).toMatchObject({ members: 5 });
      expect(readFileSync(path.join(destination, "candidate", "app-routes.ts"), "utf8")).toBe(
        "routes\n",
      );
      expect(readFileSync(path.join(destination, "candidate", "app", "child"), "utf8")).toBe(
        "child\n",
      );
    },
  );

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
    rejectArchive(
      makeTarArchive("candidate", [file("payload.bin", "a".repeat(fileSize))]),
      message,
      limits,
    );
  });

  it("extracts a prior-target hard link without retaining TarInfo records", () => {
    const { destination } = extract(
      makeTarArchive("valid-hardlink", [
        file("a-target.txt", "shared\n"),
        linkMember("b-link.txt", "candidate/a-target.txt", "LNKTYPE"),
      ]),
    );
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
    const archive = makeTarArchive(
      "cumulative-pax",
      Array.from({ length: 5 }, (_, index) => ({
        name: `candidate/pax-${index}`,
        pax_headers: { comment: "x".repeat(400) },
      })),
      "PAX_FORMAT",
    );
    rejectArchive(archive, "extension payload total exceeds 2048 bytes", [
      "--max-extension-bytes",
      "1024",
      "--max-extension-total-bytes",
      "2048",
    ]);
  });

  it.each(["pax-path", "gnu-longname", "symlink"] as const)(
    "rejects an overlong %s path value",
    (kind) => {
      const longValue = "a".repeat(4097);
      const member: ArchiveMember =
        kind === "symlink" ? linkMember("symlink", longValue, "SYMTYPE") : file(longValue, "x");
      rejectArchive(
        makeTarArchive(kind, [member], kind === "gnu-longname" ? "GNU_FORMAT" : "PAX_FORMAT"),
        "exceeds 4096 bytes",
      );
    },
  );

  it.each<[string, ArchiveMember[]]>([
    ["archive member parent is not a prior directory", [file("missing/child.txt")]],
    [
      "hard link target leaves candidate root",
      [linkMember("copy.json", "manifest.json", "LNKTYPE")],
    ],
    [
      "archive has duplicate path",
      [
        { name: "candidate/prefix", type: "DIRTYPE" },
        file("prefix/file.txt"),
        linkMember("prefix", "file.txt", "SYMTYPE"),
      ],
    ],
    [
      "path traverses a non-directory member",
      [linkMember("link", "target", "SYMTYPE"), file("link/child.txt")],
    ],
  ])("rejects %s", (message, members) => {
    rejectArchive(makeTarArchive("rejected", members), message);
  });

  it("rejects sparse archive members before extraction", () => {
    rejectArchive(
      makeTarArchive(
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
      ),
      "unsupported sparse member",
    );
  });

  it("rejects a concatenated zstd frame after the tar payload", () => {
    const archive = makeTarArchive("candidate", [file("payload.bin", "a")]);
    const trailerPath = `${archive}-trailer.txt`;
    writeFileSync(trailerPath, "EXFILTRATED-CONCATENATED-FRAME");
    appendFileSync(archive, readFileSync(compressTar(trailerPath)));
    rejectArchive(archive, "non-zero data after tar end");
  });
});
