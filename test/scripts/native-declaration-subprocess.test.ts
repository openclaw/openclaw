import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { emitNativeDeclarationsInSubprocess } from "../../scripts/lib/native-declaration-subprocess.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { materializeNativeCompiler } from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

// Windows emission does not require a managed process-tree join.
it.skipIf(process.platform === "win32")(
  "joins the native compiler before reporting a failed emission",
  async () => {
    const root = fs.realpathSync.native(roots.make("native-declaration-subprocess-"));
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    write("package.json", '{"type":"module"}');
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "NodeNext", target: "ES2023", types: [], declaration: true },
        files: ["src/index.ts"],
      }),
    );
    // TS4094 is a declaration diagnostic, so emission fails after the compiler starts.
    write("src/index.ts", "export const Widget = class {\n  private secret = 1;\n};\n");
    const exited = path.join(root, "compiler-exited");
    // Delay hook: the compiler process outlives its stdin-EOF shutdown by 500 ms,
    // which a heavily loaded host can impose on the real compiler.
    write(
      "slow-compiler-exit.mjs",
      `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) =>
  path.basename(command) === "tsc"
    ? spawn("/bin/sh", ["-c", '"$0" "$@"; code=$?; sleep 0.5; : > ${JSON.stringify(exited)}; exit $code', command, ...args], options)
    : spawn(command, args, options);
syncBuiltinESMExports();
`,
    );
    vi.stubEnv(
      "NODE_OPTIONS",
      `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(path.join(root, "slow-compiler-exit.mjs")).href}`.trim(),
    );

    await expect(
      emitNativeDeclarationsInSubprocess({
        cwd: root,
        configFile: path.join(root, "tsconfig.json"),
        roots: [path.join(root, "src/index.ts")],
        diagnostics: "declarations",
      }),
    ).rejects.toThrow(/TS4094: Property 'secret' of exported anonymous class type/u);
    expect(fs.existsSync(exited)).toBe(true);
  },
);

function revisionFixture(typescriptPackage: Record<string, unknown>) {
  const root = fs.realpathSync.native(roots.make("native-declaration-revision-"));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"type":"module"}');
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { module: "NodeNext", target: "ES2023", types: [], declaration: true },
      files: ["src/index.ts"],
    }),
  );
  write("src/index.ts", "export const answer: number = 42;\n");
  write("node_modules/typescript/package.json", JSON.stringify(typescriptPackage));
  write(
    "node_modules/typescript/revision-api.js",
    'throw new Error("revision TypeScript API selected");\n',
  );
  return {
    cwd: root,
    compilerRoot: root,
    configFile: path.join(root, "tsconfig.json"),
    roots: [path.join(root, "src/index.ts")],
    diagnostics: "declarations" as const,
  };
}

it("loads the compiler root's own pre-stable native API", async () => {
  await expect(
    emitNativeDeclarationsInSubprocess(
      revisionFixture({
        name: "typescript",
        exports: { "./package.json": "./package.json", "./unstable/async": "./revision-api.js" },
      }),
    ),
  ).rejects.toThrow(/revision TypeScript API selected/u);
});

it("keeps the installed compiler for roots without a native API", async () => {
  const request = revisionFixture({ name: "typescript", version: "6.0.3" });
  const emitted = await emitNativeDeclarationsInSubprocess(request);
  expect(emitted.declarations.get(request.roots[0]!)?.code).toContain(
    "export declare const answer: number;",
  );
});

it("adapts newer revision filesystem callbacks without upgrading the installed compiler", async () => {
  const request = revisionFixture({});
  materializeNativeCompiler(request.cwd);
  const packageRoot = path.join(request.cwd, "node_modules/typescript");
  const packageFile = path.join(packageRoot, "package.json");
  const manifest: { exports: Record<string, string> } = JSON.parse(
    fs.readFileSync(packageFile, "utf8"),
  );
  manifest.exports["./async"] = "./revision-api.js";
  manifest.exports["./fs"] = "./revision-fs.js";
  fs.writeFileSync(packageFile, JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(packageRoot, "revision-fs.js"),
    'export const serverFS = { fakeStat: Symbol("fakeStat") };\n',
  );
  // Model the 20261016 callback contract, then delegate emission to the real
  // installed compiler. Missing-file values differ from its 20260922 transport.
  fs.writeFileSync(
    path.join(packageRoot, "revision-api.js"),
    [
      'import { API as InstalledAPI, EmitOnly } from "./dist/api/async/api.js";',
      "export { EmitOnly };",
      "export class API extends InstalledAPI {",
      "  constructor(options) {",
      '    if (typeof options.fs.removeFile !== "function") throw new Error("Missing revision removeFile callback");',
      '    if (options.fs.readFile(options.cwd + "/missing.ts") !== undefined) throw new Error("Missing revision readFile must return undefined");',
      "    super({ ...options, fs: { ...options.fs, readFile: (file) => options.fs.readFile(file) ?? null } });",
      "  }",
      "}",
    ].join("\n"),
  );
  const emitted = await emitNativeDeclarationsInSubprocess(request);
  expect(emitted.declarations.get(request.roots[0]!)?.code).toContain(
    "export declare const answer: number;",
  );
});
