import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = "scripts/generate-control-ui-validators.mts";
const node = resolveTestNodeExecPath();
let scratch: string | undefined;
afterEach(() => {
  if (scratch) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

it("generates identical standalone validators across physical pnpm layouts without hiding schema drift", async () => {
  // Only TypeBox must be physically relocated. Other pinned tools retain their installed owners.
  fs.mkdirSync(path.join(repoRoot, ".artifacts"), { recursive: true });
  scratch = fs.mkdtempSync(path.join(repoRoot, ".artifacts", "validator-layouts-"));
  const closure = await build({
    absWorkingDir: repoRoot,
    entryPoints: [generator],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
  });
  const typebox = path.resolve(fileURLToPath(import.meta.resolve("typebox")), "../..");
  const outputs: Array<Record<string, string>> = [];
  for (const layout of ["hoisted", "isolated", "global-store"]) {
    const root = path.join(scratch, layout);
    for (const input of Object.keys(closure.metafile!.inputs)) {
      const destination = path.join(root, input);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, input), destination);
    }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    const modules = path.join(root, "node_modules");
    fs.mkdirSync(modules);
    const physical =
      layout === "hoisted"
        ? path.join(modules, "typebox")
        : layout === "isolated"
          ? path.join(modules, ".pnpm/typebox@1.3.36/node_modules/typebox")
          : path.join(scratch, "store/links/typebox/1.3.36/graph/node_modules/typebox");
    fs.cpSync(typebox, physical, { recursive: true });
    if (layout !== "hoisted") {
      fs.symlinkSync(physical, path.join(modules, "typebox"), "dir");
    }
    for (const name of ["esbuild", "oxfmt"]) {
      fs.symlinkSync(
        fs.realpathSync(path.join(repoRoot, "node_modules", name)),
        path.join(modules, name),
        "dir",
      );
    }
    const run = (...args: string[]) =>
      spawnSync(
        node,
        ["--import", path.join(repoRoot, "scripts/tsx.mjs"), path.join(root, generator), ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json") },
        },
      );
    const generated = run();
    expect(generated.status, generated.stdout + generated.stderr).toBe(0);
    const files = generated.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(" ").at(-1)!);
    const output = Object.fromEntries(
      files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]),
    );
    outputs.push(output);
    expect(run("--check").status).toBe(0);
    // Freshness must notice an actual public schema constraint change, not merely edited output.
    if (layout === "hoisted") {
      const schema = path.join(root, "packages/gateway-protocol/src/schema/sessions-reactions.ts");
      const source = fs.readFileSync(schema, "utf8");
      expect(source).toContain("maxLength: 32");
      fs.writeFileSync(schema, source.replace("maxLength: 32", "maxLength: 31"));
      const stale = run("--check");
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("activity.js is stale");
      expect(fs.readFileSync(path.join(root, files[0]!), "utf8")).toBe(output[files[0]!]);
      // Execute each emitted module with imports and string code generation unavailable.
      const runtime = spawnSync(
        node,
        [
          "--experimental-vm-modules",
          "--input-type=module",
          "-e",
          `
        import vm from "node:vm";
        import fs from "node:fs";
        import path from "node:path";
        const context = vm.createContext({ TextEncoder, TextDecoder }, { codeGeneration: { strings: false, wasm: false } });
        let restricted = false;
        try { vm.runInContext('Function("return 1")()', context); } catch (error) { restricted = error.name === "EvalError"; }
        if (!restricted) throw Error("String code generation must be disabled");
        const checks = {};
        for (const name of ${JSON.stringify(files)}) {
          if (!name.endsWith(".js")) continue;
          const source = fs.readFileSync(path.join(${JSON.stringify(root)}, name), "utf8");
          const module = new vm.SourceTextModule(source, {context});
          await module.link(() => { throw Error("Validators must be standalone"); });
          await module.evaluate();
          Object.assign(checks, module.namespace);
        }
        const observer = { sessionKey:"s", revision:1, updatedAt:0, health:"on-track" };
        const approval = { id:"a", urlPath:"/approve/a", createdAtMs:1, expiresAtMs:2, status:"pending",
          presentation:{kind:"exec",commandText:"echo ok",commandPreview:"echo ok",warningText:null,host:"gateway",
          nodeId:null,agentId:"main",allowedDecisions:["allow-once","deny"]} };
        const replay = { sessionKey:"s", updatedAtMs:1, approvals:[approval], truncated:false };
        const values = [checks.isSessionObserverDigest({...observer,headline:"😀".repeat(120)}),
          checks.isSessionObserverDigest({...observer,headline:"😀".repeat(121)}), checks.isSessionApprovalReplay(replay)];
        approval.presentation.allowedDecisions = ["allow-once","allow-once"];
        values.push(checks.isSessionApprovalReplay(replay));
        console.log(JSON.stringify(values));
      `,
        ],
        { encoding: "utf8" },
      );
      expect(runtime.status, runtime.stdout + runtime.stderr).toBe(0);
      expect(JSON.parse(runtime.stdout)).toEqual([true, false, true, false]);
    }
  }
  expect(outputs[1]).toEqual(outputs[0]);
  expect(outputs[2]).toEqual(outputs[0]);
});
