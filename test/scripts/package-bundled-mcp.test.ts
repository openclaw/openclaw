import { expect, it } from "vitest";
import { collectPatchedMcpArtifactErrors as errors } from "../../scripts/lib/package-bundled-mcp.mts";

// Independent hashes: columns are 1.8.0, 1.9.0, 1.10.1, 1.11.0, 1.12.0; a single hash applies to all.
const HASH_ROWS =
  `build/src/bin/chrome-devtools-mcp.js 9f380d06e1ac05b257e27e708c0cc4b4ba190e285ed6eb6c8aa50978d98a12c5 9f380d06e1ac05b257e27e708c0cc4b4ba190e285ed6eb6c8aa50978d98a12c5 9f380d06e1ac05b257e27e708c0cc4b4ba190e285ed6eb6c8aa50978d98a12c5 e8b0290a8fe9a1edc31d595ccc870df926bfaaafe19fb14cd4d8d47bf6194979 e8b0290a8fe9a1edc31d595ccc870df926bfaaafe19fb14cd4d8d47bf6194979
LICENSE 58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd
build/src/TextSnapshot.js 299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b 299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b 299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b 5c647c3d0b416bdfc1bcaf1b1136f6a7682db05cf59982e3ab6f17d00d2d17ac 21be06826da0dafaadf712b1dc689f6f07c63042a0b6ee30c4afca9a0d616963
build/src/bin/chrome-devtools-mcp-main.js fc383cb3e5db5f18cf1e8c49221212c669825248874ba91c90ba9035e175f5b4 5ca0e81196ab6b6e1481629a2dcae7f416b3b38f74555e3138ad5cdbb055e809 10603ea8c2ac9f69a42791100701795018ebfaa522a7c93d783ed583cce5cce4 68bffbf26cf0e8840409079456a7681c03e737cd977935c2e0c424c1b8a0700a fc7e2ca9f850a71a015d42f771a4c96f7ee81e21fbcdbd5e1559ccdbac800a96
build/src/third_party/THIRD_PARTY_NOTICES 8f10277934fe6888173f41f7cbbd9112d208c8c931bf163db59110f69f119e53 975febf536bb1c83c031a7888b90bdf1ffe8dc46000e0698eac364491dca8ac4 6ae0ce181dbc9ba4217b6aad679d7503ed3ab56c45e6f3647e9ab753aa97b67b 6476ce17667202e92ea191d166050a3ab74f465f2f7a2b6b01dcb4e9477b6a0a 79e0eeaebdc9a605a3a2a51ecfe8da1e0f68df37416e405ba96dd4376a488e64
build/src/McpPage.js b9e791d758e4d28589525e2d427600e24b271d365a5879893a392043a11cf426 6d83dbd4d79c913664fbfa428d138b22fe4246612ab4dfcd93e9d8e62d5d6b51 47aa13c6b28cc11e1b0883532edea97cfde7563d78d143035850852d09809975 4044a30df6292a5d4517f718c32818e9c85f8051c318ec88bef7aa127d883a36 313ce4bfaaea85ab3c57a0bb8f4ad23c093ad33f25407170b2bef6f1654b30b8
build/src/third_party/index.js a8f5cb1e02405d347117114141b58572f71c083861fb50ab31a27511e3a279bf 7609bb6c575c7c1152b3f4233ad4b98d97885c62ccff7bd9ee29257ca8ffc83f c988e0684584b75e87ae04b768c4f8ae7064401afe5187ec0d4878b2c6833f12 b047499006b0027bd37165fa8197fa6fa5caa9b8c07d938992857659270ec493 e1752f75684b672362dc3ae77a399407c509b76471fca08f967fc44fe2cb267b
build/src/OPENCLAW_PATCH_NOTICE.md 8f5a32aaedf4bb6f8ad39f226bd343bf804132c11ebc6c3c19f667669856287c 0e53a04f337a3760f2f1adab9c20e3b4f07019795f503266c0b68e0f46d55a6c 4bf44b52a80b5860b2160bc83407a5f0dd09f1801c85d0a2b6e4fec26bd7045d 41aada055258ec8754581f6cee1e3ed505499be8373969e6267031ebabc00594 c490fb032360cf26141c4a8d72c6ab4587613051619aa88c346662eaaa6daee5`.split(
    "\n",
  );
const VERSIONS = ["1.8.0", "1.9.0", "1.10.1", "1.11.0", "1.12.0"] as const;
type Version = (typeof VERSIONS)[number];
function versionHashes(version: Version): Record<string, string> {
  const column = VERSIONS.indexOf(version);
  return Object.fromEntries(
    HASH_ROWS.map((row): [string, string] => {
      const [file = "", first = "", ...rest] = row.split(" ");
      return [file, [first, ...rest][column] ?? first];
    }),
  );
}
const currentHashes = versionHashes("1.12.0");
it("preserves the bootstrap producer's current-runtime default", () => {
  for (const version of VERSIONS) {
    const { declaredVersion: _pin, ...input } = fixture(version);
    const result = errors(input);
    if (version === "1.12.0") {
      expect(result).toEqual([]);
    } else {
      expect(result).toContain(ESM_ERROR);
    }
  }
});

const CLI = "build/src/bin/chrome-devtools-mcp.js";
const ESM_ERROR = "bundled chrome-devtools-mcp must be ESM version 1.12.0";
const ASSETS = [
  "build/src/third_party/devtools-formatter-worker.js",
  "build/src/third_party/devtools-heap-snapshot-worker.js",
  "build/src/third_party/lighthouse-devtools-mcp-bundle.js",
  "build/src/third_party/bundled-packages.json",
  "build/src/third_party/issue-descriptions/example.md",
];

function fixture(version: Version = "1.12.0") {
  const hashes = versionHashes(version);
  return {
    declaredVersion: version,
    manifest: { version, type: "module", bin: { "chrome-devtools-mcp": "./" + CLI } },
    files: new Set([...Object.keys(hashes), ...ASSETS]),
    sha256: (file: string) => hashes[file],
  };
}

it.each(VERSIONS)("accepts the intact %s contract", (version) => {
  expect(errors(fixture(version))).toEqual([]);
});

it("rejects changed runtime bytes even with artifact-supplied replacement hashes", () => {
  const input = fixture();
  expect(
    errors({
      ...input,
      manifest: { ...input.manifest, hashes: { [CLI]: "0".repeat(64) } },
      sha256: () => "0".repeat(64),
    }).toSorted(),
  ).toEqual(
    Object.keys(currentHashes)
      .map((file) => "bundled chrome-devtools-mcp has unpatched or changed runtime entry " + file)
      .toSorted(),
  );
});

it.each([
  ["1.9.0", "module", "./" + CLI, [ESM_ERROR]],
  [
    "1.10.1",
    "commonjs",
    "./other.js",
    [ESM_ERROR, "bundled chrome-devtools-mcp must expose CLI " + CLI],
  ],
] as const)("rejects an incompatible manifest: %s/%s/%s", (version, type, bin, expectedErrors) => {
  const input = fixture();
  input.manifest = { version, type, bin: { "chrome-devtools-mcp": bin } };
  expect(errors(input)).toEqual(expectedErrors);
});

it("reports every missing runtime entry", () => {
  const input = fixture();
  input.files.clear();
  expect(errors(input).toSorted()).toEqual(
    [
      ...[...ASSETS.slice(0, -1), ...Object.keys(currentHashes)].map(
        (file) => "bundled chrome-devtools-mcp is missing required runtime entry " + file,
      ),
      "bundled chrome-devtools-mcp is missing third-party issue descriptions",
    ].toSorted(),
  );
});

it.each([null, "toString"])("rejects unpinned or unknown declarations: %s", (declaredVersion) => {
  expect(errors({ ...fixture(), declaredVersion })).toEqual([
    "package.json dependencies.chrome-devtools-mcp must be pinned to a supported patched version",
  ]);
});
