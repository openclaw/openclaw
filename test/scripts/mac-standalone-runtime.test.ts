import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const commit = "a".repeat(40);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bunPin = JSON.parse(readFileSync("scripts/lib/openclaw-bun.json", "utf8"));

function compilerIdentity(arch: string) {
  return {
    version: "1.4.3",
    revision: bunPin.revision,
    commit: bunPin.commit,
    executableSha256: bunPin.artifacts[`darwin-${arch}`].executableSha256,
  };
}

function fixture(arch = "arm64", sqlite = "sqlite") {
  const root = temps.make("mac-standalone-");
  for (const directory of ["scripts/lib", "dist", "bin", "input/runtime/lib"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  copyFileSync("scripts/stage-mac-runtime.sh", path.join(root, "scripts/stage-mac-runtime.sh"));
  symlinkSync(
    path.resolve("scripts/lib/mac-standalone-runtime.mjs"),
    path.join(root, "scripts/lib/mac-standalone-runtime.mjs"),
  );
  symlinkSync(process.execPath, path.join(root, "bin/node"));
  symlinkSync(path.resolve("scripts/tsx.mjs"), path.join(root, "scripts/tsx.mjs"));
  symlinkSync(
    path.resolve("scripts/lib/desktop-runtime-plugins.mjs"),
    path.join(root, "scripts/lib/desktop-runtime-plugins.mjs"),
  );
  for (const id of ["codex", "discord", "imessage", "slack", "sms", "voice-call", "whatsapp"]) {
    const directory = path.join(root, "dist/extensions", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "openclaw.plugin.json"), JSON.stringify({ id }));
  }

  writeFileSync(path.join(root, "input/runtime/lib/libsqlite3.dylib"), sqlite);
  const bytes = '#!/bin/sh\nprintf "OpenClaw 2026.10.14\\n"\n';
  writeFileSync(path.join(root, "input/openclaw"), bytes);
  chmodSync(path.join(root, "input/openclaw"), 0o755);
  writeFileSync(path.join(root, "input/runtime/package.json"), "{}");
  const manifest = {
    schemaVersion: 1,
    mode: "jit",
    plugins: {
      embedded: ["codex", "discord", "imessage", "slack", "sms", "voice-call", "whatsapp"],
      omitted: [],
    },
    target: { platform: "darwin", arch },
    bun: compilerIdentity(arch),
    openclaw: { version: "2026.10.14", commit },
    executable: { path: "openclaw", sizeBytes: Buffer.byteLength(bytes), sha256: hash(bytes) },
    runtime: {
      path: "runtime",
      sizeBytes: 2 + Buffer.byteLength(sqlite),
      sha256: hash(
        `lib/libsqlite3.dylib\0file\0${hash(sqlite)}\npackage.json\0file\0${hash("{}")}\n`,
      ),
      fileCount: 2,
      symlinkCount: 0,
      sqlite: {
        source: "bundled",
        path: "lib/libsqlite3.dylib",
        version: "3.53.4",
        sha256: hash(sqlite),
      },
      categories: { nativeLibraries: { files: 1, bytes: Buffer.byteLength(sqlite) } },
    },
    macos: {
      hardenedRuntime: true,
      entitlements: {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.disable-library-validation": true,
      },
    },
  };
  const save = () =>
    writeFileSync(path.join(root, "input/manifest.json"), JSON.stringify(manifest));
  save();
  writeFileSync(
    path.join(root, "dist/build-info.json"),
    JSON.stringify({ version: "2026.10.14", commit }),
  );
  const output = path.join(root, "output");
  const run = (env: Record<string, string> = {}, arches = ["arm64"]) =>
    spawnSync("/bin/bash", [path.join(root, "scripts/stage-mac-runtime.sh"), output, ...arches], {
      encoding: "utf8",
      env: {
        PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        OPENCLAW_MAC_RUNTIME_PREBUILT: path.join(root, "input"),
        ...env,
      },
    });
  return { root, output, manifest, save, run };
}

describe.skipIf(process.platform !== "darwin")("standalone Mac runtime staging", () => {
  it.each(["arm64", "x64"])(
    "stages a validated %s executable and sidecar, with app ownership and no loose interpreter tree",
    (arch) => {
      const f = fixture(arch);
      const result = f.run({}, [arch === "x64" ? "x86_64" : arch]);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(f.output, "openclaw"), "utf8")).toContain("OpenClaw");
      expect(existsSync(path.join(f.output, "bin/bun"))).toBe(false);
      expect(existsSync(path.join(f.output, "lib/node_modules"))).toBe(false);
      expect(existsSync(path.join(f.output, "lib/libsqlite3.dylib"))).toBe(false);
      expect(readFileSync(path.join(f.output, "runtime/lib/libsqlite3.dylib"), "utf8")).toBe(
        "sqlite",
      );
      expect(
        JSON.parse(readFileSync(path.join(f.output, "runtime/openclaw-install-owner.json"), "utf8"))
          .owner,
      ).toBe("macos-app");
      const packaged = JSON.parse(readFileSync(path.join(f.output, "manifest.json"), "utf8"));
      expect(packaged.buildId).toMatch(/^[a-f0-9]{64}$/);
      expect(packaged.openclaw.commit).toBe(commit);
      expect(packaged.runtime.sha256).not.toBe(f.manifest.runtime.sha256);
      expect(packaged.runtime.sqlite).toEqual(f.manifest.runtime.sqlite);
      expect(packaged.runtime.categories).toEqual(f.manifest.runtime.categories);
    },
  );

  it.each([
    { field: "revision", value: "unapproved", reason: "wrong" },
    { field: "commit", value: "b".repeat(40), reason: "wrong" },
    {
      field: "executableSha256",
      value: compilerIdentity("x64").executableSha256,
      reason: "wrong architecture",
    },
    { field: "revision", value: undefined, reason: "missing" },
    { field: "commit", value: undefined, reason: "missing" },
    { field: "executableSha256", value: undefined, reason: "missing" },
  ])("rejects $reason compiler $field before publishing", ({ field, value }) => {
    const f = fixture();
    writeFileSync(
      path.join(f.root, "input/manifest.json"),
      JSON.stringify({ ...f.manifest, bun: { ...f.manifest.bun, [field]: value } }),
    );
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Standalone Bun ${field} mismatch`);
    expect(existsSync(f.output)).toBe(false);
  });

  it("passes the desktop selection to the builder when no prebuilt output is supplied", () => {
    const f = fixture();
    writeFileSync(
      path.join(f.root, "scripts/stage-openclaw-bun.sh"),
      '#!/bin/bash\nmkdir -p "$1/bin"\ncp "' +
        path.join(f.root, "fake-builder") +
        '" "$1/bin/bun"\n',
    );
    writeFileSync(
      path.join(f.root, "fake-builder"),
      `#!/bin/bash
printf '%s\\n' "$@" > "${path.join(f.root, "builder-args")}"
cp -R "${path.join(f.root, "input")}" "$2"
`,
    );
    chmodSync(path.join(f.root, "fake-builder"), 0o755);
    const result = f.run({ OPENCLAW_MAC_RUNTIME_PREBUILT: "" });
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(path.join(f.root, "builder-args"), "utf8").trim().split("\n");
    expect(args.slice(2)).toEqual([
      "--plugins",
      "codex,discord,imessage,slack,sms,voice-call,whatsapp",
    ]);
  });

  it.each([
    { reason: "missing", embedded: undefined },
    { reason: "empty", embedded: [] },
    { reason: "extra", embedded: ["codex", "unexpected"] },
    { reason: "duplicate", embedded: ["codex", "codex"] },
  ])("rejects a prebuilt runtime with a $reason embedded plugin set", ({ embedded }) => {
    const f = fixture();
    Object.assign(f.manifest, { plugins: { embedded, omitted: [] } });
    f.save();
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Standalone desktop plugin selection mismatch");
    expect(existsSync(f.output)).toBe(false);
  });

  it("identifies the completed unsigned sidecar and preserves that identity during signing", () => {
    const first = fixture();
    const second = fixture("arm64", "other-sqlite");
    for (const f of [first, second]) {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
    }
    const firstManifest = JSON.parse(
      readFileSync(path.join(first.output, "manifest.json"), "utf8"),
    );
    const unsigned = JSON.parse(readFileSync(path.join(second.output, "manifest.json"), "utf8"));
    expect(unsigned.buildId).not.toBe(firstManifest.buildId);
    writeFileSync(path.join(second.output, "openclaw"), "signed executable");
    writeFileSync(path.join(second.output, "runtime/lib/libsqlite3.dylib"), "signed library");
    const sealed = spawnSync(
      process.execPath,
      [path.resolve("scripts/lib/mac-standalone-runtime.mjs"), "seal", second.output],
      { encoding: "utf8" },
    );
    expect(sealed.status, sealed.stderr).toBe(0);
    const signed = JSON.parse(readFileSync(path.join(second.output, "manifest.json"), "utf8"));
    expect(signed.buildId).toBe(unsigned.buildId);
    expect(signed.executable.sha256).not.toBe(unsigned.executable.sha256);
    expect(signed.runtime.sha256).not.toBe(unsigned.runtime.sha256);
    expect(signed.runtime.sqlite.sha256).toBe(hash("signed library"));
    expect(signed.runtime.sqlite.version).toBe("3.53.4");
  });

  it("rejects a builder output without its bundled SQLite library", () => {
    const f = fixture();
    writeFileSync(
      path.join(f.root, "scripts/build-mac-sqlite.sh"),
      '#!/bin/bash\nmkdir -p "$2/lib"\nprintf app-built-sqlite > "$2/lib/libsqlite3.dylib"\n',
    );
    unlinkSync(path.join(f.root, "input/runtime/lib/libsqlite3.dylib"));
    Object.assign(f.manifest.runtime, {
      sizeBytes: 2,
      sha256: hash(`package.json\0file\0${hash("{}")}\n`),
      fileCount: 1,
    });
    f.save();
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bundled SQLite");
    expect(existsSync(f.output)).toBe(false);
  });

  it.each(["commit", "mode", "executable", "sidecar", "target", "entitlements"])(
    "rejects mismatched %s before publishing",
    (failure) => {
      const f = fixture();
      if (failure === "commit") {
        f.manifest.openclaw.commit = "b".repeat(40);
      }
      if (failure === "mode") {
        f.manifest.mode = "bytecode";
      }
      if (failure === "target") {
        f.manifest.target.arch = "x64";
      }
      if (failure === "entitlements") {
        Object.assign(f.manifest.macos.entitlements, {
          "com.apple.security.cs.allow-unsigned-executable-memory": true,
        });
      }
      if (failure === "executable") {
        writeFileSync(path.join(f.root, "input/openclaw"), "wrong executable");
      }
      if (failure === "sidecar") {
        writeFileSync(path.join(f.root, "input/runtime/package.json"), '{"wrong":true}');
      }
      f.save();
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/mismatch|entitlements/i);
      expect(existsSync(f.output)).toBe(false);
    },
  );

  it("accepts bytecode only with the explicit packaging mode", () => {
    const f = fixture();
    f.manifest.mode = "bytecode";
    f.save();
    const result = f.run({ OPENCLAW_MAC_RUNTIME_MODE: "bytecode" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects universal requests before invoking the single-target builder", () => {
    const f = fixture();
    const result = f.run({}, ["arm64", "x86_64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("one architecture");
    expect(existsSync(f.output)).toBe(false);
  });
});

// Native executable fixture exercises the complete signed-runtime verifier boundary.
// Its fixed CLI replies isolate admission checks; real native loading is release proof.
let verifierExecutable: Buffer | undefined;
function compileVerifierExecutable(root: string) {
  if (verifierExecutable) {
    return verifierExecutable;
  }
  const file = path.join(root, "fixture-cli");
  const result = spawnSync(
    "/usr/bin/xcrun",
    ["clang", "-x", "objective-c", "-framework", "Foundation", "-", "-o", file],
    {
      encoding: "utf8",
      input: `#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <arpa/inet.h>

static void allowed(int result, const char *operation) {
  if (result < 0) { perror(operation); exit(93); }
}

static void denied(int result, const char *operation) {
  if (result != -1 || (errno != EPERM && errno != EACCES)) {
    fprintf(stderr, "%s was not denied by the sandbox (errno %d)\\n", operation, errno);
    exit(94);
  }
}

static struct sockaddr_un unix_address(const char *file) {
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  address.sun_len = sizeof(address);
  if (strlen(file) >= sizeof(address.sun_path)) { fputs("fixture socket path too long", stderr); exit(95); }
  strcpy(address.sun_path, file);
  return address;
}

static void check_sandbox(const char *outside) {
  char directory[PATH_MAX], file[PATH_MAX];
  snprintf(directory, sizeof(directory), "%s/oc-br-test00", getenv("TMPDIR"));
  allowed(mkdir(directory, 0700), "inside socket directory");
  snprintf(file, sizeof(file), "%s/resource.sock", directory);
  struct sockaddr_un inside = unix_address(file);
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  allowed(server, "inside socket");
  allowed(bind(server, (struct sockaddr *)&inside, sizeof(inside)), "inside Unix bind");
  allowed(listen(server, 1), "inside Unix listen");
  int client = socket(AF_UNIX, SOCK_STREAM, 0);
  allowed(client, "inside client");
  allowed(connect(client, (struct sockaddr *)&inside, sizeof(inside)), "inside Unix connect");
  close(client); close(server); unlink(file); rmdir(directory);

  snprintf(file, sizeof(file), "%s.bind", outside);
  struct sockaddr_un external = unix_address(file);
  client = socket(AF_UNIX, SOCK_STREAM, 0);
  allowed(client, "outside bind socket");
  denied(bind(client, (struct sockaddr *)&external, sizeof(external)), "outside Unix bind");
  close(client);
  external = unix_address(outside);
  client = socket(AF_UNIX, SOCK_STREAM, 0);
  allowed(client, "outside client");
  denied(connect(client, (struct sockaddr *)&external, sizeof(external)), "outside Unix connect");
  close(client);

  struct sockaddr_in ip = {0};
  ip.sin_family = AF_INET;
  ip.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  client = socket(AF_INET, SOCK_STREAM, 0);
  allowed(client, "IP bind socket");
  denied(bind(client, (struct sockaddr *)&ip, sizeof(ip)), "IP bind");
  close(client);
  ip.sin_port = htons(9);
  client = socket(AF_INET, SOCK_STREAM, 0);
  allowed(client, "IP client");
  denied(connect(client, (struct sockaddr *)&ip, sizeof(ip)), "IP connect");
  close(client);
}

int main(int argc, char **argv) {
  if (getenv("OPENCLAW_NO_RESPAWN")) {
    fputs("unexpected respawn override", stderr);
    return 97;
  }
  char root[PATH_MAX], mode[64] = "valid", file[PATH_MAX], outside[PATH_MAX] = "";
  realpath(argv[0], root); *strrchr(root, '/') = 0;
  snprintf(file, sizeof(file), "%s/proof-case", root);
  FILE *input = fopen(file, "r");
  if (input) {
    fgets(mode, sizeof(mode), input); mode[strcspn(mode, "\\r\\n")] = 0;
    fgets(outside, sizeof(outside), input); fclose(input);
  }
  if (argc > 1 && !strcmp(argv[1], "--version")) { puts("OpenClaw 2026.10.14"); return 0; }
  if (argc > 1 && !strcmp(argv[1], "doctor")) {
    if (!strcmp(mode, "sandbox")) { check_sandbox(outside); }
    if (getenv("OPENCLAW_SQLITE_LIBRARY")) { fputs("unexpected SQLite override", stderr); return 92; }
    char sqlite[PATH_MAX];
    snprintf(sqlite, sizeof(sqlite), "%s/runtime/lib/libsqlite3.dylib", root);
    const char *selected = !strcmp(mode, "wrong-sqlite") ? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib" : sqlite;
    int split = strlen(selected) / 2;
    printf("│ SQLite (doctor process):\\n│ %.*s\\n│ %s (3.53.0, extension loading enabled)\\n",
      split, selected, selected + split);
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "memory")) {
    @autoreleasepool {
      NSData *data = [NSData dataWithContentsOfFile:@(getenv("OPENCLAW_CONFIG_PATH"))];
      NSDictionary *config = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
      NSDictionary *remote = config[@"memory"][@"search"][@"remote"];
      NSURL *endpoint = [NSURL URLWithString:remote[@"baseUrl"]];
      if (![remote[@"apiKey"] length] || ![endpoint.host isEqualToString:@"127.0.0.1"] ||
          [endpoint.port intValue] != 9) {
        fputs("isolated embedding credentials and endpoint are required", stderr);
        return 96;
      }
    }
    char extension[PATH_MAX];
    snprintf(extension, sizeof(extension), "%s/runtime/node_modules/sqlite-vec/vec0.dylib", root);
    printf("[{\\"agentId\\":\\"main\\",\\"status\\":{\\"backend\\":\\"builtin\\",\\"vector\\":{\\"enabled\\":true,\\"storeAvailable\\":%s,\\"extensionPath\\":\\"%s\\"}}}]\\n",
      !strcmp(mode, "vector-unavailable") ? "false" : "true",
      !strcmp(mode, "outside-vector") ? "/usr/bin/true" : extension);
    return 0;
  }
  if (argc > 1 && strstr(argv[1], "mac-node-worker.js")) {
    puts("{\\"type\\":\\"ready\\",\\"version\\":\\"2026.10.14\\",\\"manifest\\":{\\"commands\\":[\\"system.run\\",\\"system.which\\",\\"browser.proxy\\",\\"mcp.tools.call.v1\\"]}}");
    fflush(stdout); char line[128]; fgets(line, sizeof(line), stdin); return 0;
  }
  return 0;
}
`,
      timeout: 15_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  verifierExecutable = readFileSync(file);
  return verifierExecutable;
}

describe.skipIf(process.platform !== "darwin")("Mac packaged SQLite capability admission", () => {
  it.each([
    { mode: "valid", underHome: false },
    { mode: "valid", underHome: true },
    { mode: "wrong-sqlite", underHome: false },
    { mode: "vector-unavailable", underHome: false },
    { mode: "outside-vector", underHome: false },
    { mode: "sandbox", underHome: false },
    { mode: "long-root", underHome: false },
  ])(
    "checks CLI capabilities after relocation ($mode, source under home: $underHome)",
    async ({ mode, underHome }) => {
      const parent = temps.make("mcv-", underHome ? os.userInfo().homedir : undefined);
      const root = path.join(parent, "build", "OpenClaw.app", "Contents", "Resources", "runtime");
      const runtime = path.join(root, "runtime");
      for (const directory of ["dist/control-ui", "lib", "node_modules/sqlite-vec"]) {
        mkdirSync(path.join(runtime, directory), { recursive: true });
      }
      const fixtureExecutable = compileVerifierExecutable(root);
      writeFileSync(path.join(root, "openclaw"), fixtureExecutable);
      chmodSync(path.join(root, "openclaw"), 0o755);
      const outsideSocket = path.join(parent, "outside.sock");
      writeFileSync(path.join(root, "proof-case"), `${mode}\n${outsideSocket}`);
      writeFileSync(path.join(runtime, "dist/control-ui/index.html"), "fixture");
      writeFileSync(path.join(runtime, "lib/libsqlite3.dylib"), "fixture library");
      writeFileSync(path.join(runtime, "node_modules/sqlite-vec/vec0.dylib"), "fixture vector");
      const { describeStandaloneRuntime, sha256File } =
        await import("../../scripts/lib/bun-standalone-contract.mjs");
      writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          mode: "jit",
          target: { platform: "darwin", arch: process.arch },
          bun: compilerIdentity(process.arch),
          openclaw: { version: "2026.10.14", commit },
          executable: {
            path: "openclaw",
            sizeBytes: fixtureExecutable.length,
            sha256: await sha256File(path.join(root, "openclaw")),
          },
          runtime: await describeStandaloneRuntime(runtime),
          macos: {
            hardenedRuntime: true,
            entitlements: {
              "com.apple.security.cs.allow-jit": true,
              "com.apple.security.cs.disable-library-validation": true,
            },
          },
        }),
      );
      const stage = spawnSync(
        process.execPath,
        [path.resolve("scripts/lib/mac-standalone-runtime.mjs"), "stage", root],
        { encoding: "utf8" },
      );
      expect(stage.status, stage.stderr).toBe(0);
      const expected = path.join(root, "expected.json");
      writeFileSync(expected, JSON.stringify({ version: "2026.10.14", commit }));
      const tempRoot = path.join(parent, "long-" + "x".repeat(80));
      if (mode === "long-root") {
        mkdirSync(tempRoot);
      }
      const server = mode === "sandbox" ? createServer((socket) => socket.destroy()) : undefined;
      try {
        if (server) {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(outsideSocket, resolve);
          });
        }
        const result = spawnSync(
          process.execPath,
          [path.resolve("scripts/verify-mac-runtime.mjs"), root, expected],
          {
            encoding: "utf8",
            timeout: 20_000,
            env: mode === "long-root" ? { ...process.env, TMPDIR: tempRoot } : process.env,
          },
        );
        if (mode === "valid" || mode === "sandbox") {
          expect(result.status, result.stderr).toBe(0);
        } else {
          expect(result.status, result.stdout + result.stderr).not.toBe(0);
          const failure =
            mode === "long-root"
              ? "TMPDIR is too long"
              : mode === "wrong-sqlite"
                ? "Doctor SQLite"
                : "vector";
          expect(result.stderr).toContain(failure);
        }
      } finally {
        if (server) {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        }
      }
    },
  );
});
