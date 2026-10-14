import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { emitNativeDeclarationsInSubprocess } from "../../scripts/lib/native-declaration-subprocess.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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
