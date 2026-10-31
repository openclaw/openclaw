import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  assertRealDirectory,
  createAssetManifest,
  validateAssetPath,
  validateBundleClosure,
  validateWorkerCapabilities,
  writeAssetManifest,
} from "./asset-manifest.mjs";

const document = (
  head = '<script type="module" src="./assets/main.js"></script>',
  body = "<main><openclaw-team-event-product></openclaw-team-event-product></main>",
) =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Team event</title>${head}</head><body>${body}</body></html>`;
const moduleTag = '<script type="module" src="./assets/main.js"></script>';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "event-manifest-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), document());
  writeFileSync(path.join(root, "assets/main.js"), "export const event = true;\n");
  return root;
}
const expected = ["index.html", "assets/main.js"];

function bundleForFiles(files) {
  return Object.fromEntries(
    files.map((name) => [
      name,
      {
        type: name.endsWith(".js") ? "chunk" : "asset",
        ...(name.endsWith(".js") ? { imports: [], dynamicImports: [] } : {}),
        viteMetadata: { importedCss: new Set(), importedAssets: new Set() },
      },
    ]),
  );
}

// Execute the production walk with real Windows path semantics on every host.
// A recording filesystem verifies each lstat boundary without requiring a Windows share.
const windowsDirectories = [
  { input: "C:\\work\\out", visited: ["C:\\work", "C:\\work\\out"] },
  {
    input: "\\\\server\\share\\work\\out",
    visited: ["\\\\server\\share\\work", "\\\\server\\share\\work\\out"],
  },
];

test("walks drive and UNC directories without repeating their root", () => {
  for (const { input, visited } of windowsDirectories) {
    const actual = [];
    const walk = runInNewContext(`(${assertRealDirectory.toString()})`, {
      path: path.win32,
      lstatSync: (directory) => {
        actual.push(directory);
        return { isSymbolicLink: () => false, isDirectory: () => true };
      },
    });
    walk(input);
    assert.deepEqual(actual, visited);
  }
});

test("rejects symlinks and non-directories at each drive and UNC component", () => {
  for (const { input, visited } of windowsDirectories) {
    for (const [index, rejected] of visited.entries()) {
      for (const symbolic of [true, false]) {
        const actual = [];
        const walk = runInNewContext(`(${assertRealDirectory.toString()})`, {
          path: path.win32,
          lstatSync: (directory) => {
            actual.push(directory);
            return {
              isSymbolicLink: () => directory === rejected && symbolic,
              isDirectory: () => symbolic || directory !== rejected,
            };
          },
        });
        assert.throws(() => walk(input), /Unsafe directory:/);
        assert.deepEqual(actual, visited.slice(0, index + 1));
      }
    }
  }
});

test("hashes exact bytes with stable order and excludes the manifest itself", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "assets/style.css"), "body{}\n");
  const paths = [...expected, "assets/style.css"];
  const manifest = createAssetManifest(root, paths);
  assert.deepEqual(manifest, createAssetManifest(root, paths.toReversed()));
  assert.deepEqual(
    manifest.assets.map((item) => item.path),
    ["assets/main.js", "assets/style.css", "index.html"],
  );
  const html = manifest.assets.at(-1);
  const bytes = readFileSync(path.join(root, "index.html"));
  assert.equal(html.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(html.size, bytes.length);
  assert.equal(html.mimeType, "text/html; charset=utf-8");
  assert.equal(manifest.assets[1].mimeType, "text/css; charset=utf-8");
  assert.deepEqual(Object.keys(html).toSorted(), ["mimeType", "path", "sha256", "size"]);
  writeAssetManifest(root, paths, bundleForFiles(paths));
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, "asset-manifest.json"), "utf8")),
    manifest,
  );
  assert.throws(() => writeAssetManifest(root, paths, bundleForFiles(paths)));
});

test("requires complete matching bundle metadata before writing a manifest", (t) => {
  const incomplete = bundleForFiles(expected);
  delete incomplete["assets/main.js"].viteMetadata;
  for (const bundle of [
    undefined,
    null,
    {},
    expected,
    incomplete,
    bundleForFiles(["index.html"]),
    bundleForFiles([...expected, "assets/extra.js"]),
  ]) {
    const root = fixture(t);
    assert.throws(() => writeAssetManifest(root, expected, bundle));
    assert.throws(() => readFileSync(path.join(root, "asset-manifest.json")), { code: "ENOENT" });
  }
});

test("rejects missing and external bundle dependencies before manifest publication", (t) => {
  for (const field of ["imports", "dynamicImports", "importedCss", "importedAssets"]) {
    for (const dependency of ["assets/missing.js", "https://example.invalid/external.js"]) {
      const root = fixture(t);
      const bundle = bundleForFiles(expected);
      const chunk = bundle["assets/main.js"];
      if (field === "imports" || field === "dynamicImports") {
        chunk[field] = [dependency];
        writeFileSync(
          path.join(root, "assets/main.js"),
          field === "imports"
            ? `import ${JSON.stringify(dependency)};`
            : `import(${JSON.stringify(dependency)});`,
        );
      } else {
        chunk.viteMetadata[field].add(dependency);
      }
      assert.throws(() => writeAssetManifest(root, expected, bundle));
      assert.throws(() => readFileSync(path.join(root, "asset-manifest.json")), { code: "ENOENT" });
    }
  }
});

test("rejects missing, extra, duplicate, unsafe and unsupported paths", (t) => {
  const root = fixture(t);
  for (const name of [
    "/etc/passwd",
    "../outside.js",
    "assets/../outside.js",
    "assets\\bad.js",
    "assets/.hidden.js",
    "assets/a%2fb.js",
    "assets/sw.js",
    "assets/service-worker.js",
    "assets/a.js.map",
    "assets/a.JS",
    "assets/other.html",
  ]) {
    assert.throws(() => validateAssetPath(name), name);
  }
  assert.throws(() => createAssetManifest(root, [...expected, "assets/missing.js"]));
  assert.throws(() => createAssetManifest(root, ["index.html"]));
  assert.throws(() => createAssetManifest(root, [...expected, "assets/main.js"]));
  writeFileSync(path.join(root, "assets/extra.css"), "extra");
  assert.throws(() => createAssetManifest(root, expected));
});

test("matches receiver path, count, and supported MIME limits", (t) => {
  const root = fixture(t);
  for (const extension of ["woff", "ttf", "otf", "wasm"]) {
    assert.throws(() => validateAssetPath(`assets/test.${extension}`));
  }
  for (const name of [
    "assets/font.woff2",
    "assets/worker-guide.css",
    "assets/co-worker.png",
    "assets/event-worker-x.js",
    "assets/worker/file.css",
  ]) {
    assert.doesNotThrow(() => validateAssetPath(name), name);
  }
  for (const name of [
    "assets/sw.js",
    "assets/service-worker.js",
    "assets/nested/service_worker.a.js",
  ]) {
    assert.throws(() => validateAssetPath(name), name);
  }
  assert.throws(() => validateAssetPath(`assets/${"a".repeat(505)}.js`));
  assert.throws(() => validateAssetPath(`assets/${"x/".repeat(7)}a.js`));
  assert.throws(() => createAssetManifest(root, Array(257).fill("assets/a.js")));
});

test("inert worker-named assets pass the manifest receiver contract", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "assets/worker-guide.css"), "body{};");
  writeFileSync(path.join(root, "assets/co-worker.png"), "png");
  assert.doesNotThrow(() =>
    createAssetManifest(root, [...expected, "assets/worker-guide.css", "assets/co-worker.png"]),
  );
});

test("rejects oversized individual and total asset bytes before reading", (t) => {
  const root = fixture(t);
  const sparse = (name, size) => {
    const fd = openSync(path.join(root, name), "w");
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
  };
  sparse("assets/large.png", 8 * 1024 * 1024 + 1);
  assert.throws(() => createAssetManifest(root, [...expected, "assets/large.png"]), /size limit/);
  rmSync(path.join(root, "assets/large.png"));
  const names = Array.from({ length: 4 }, (_, i) => `assets/large${i}.png`);
  for (const name of names) {
    sparse(name, 8 * 1024 * 1024);
  }
  assert.throws(() => createAssetManifest(root, [...expected, ...names]), /total exceeds/);
});

test("receiver inventory limit includes directories and the manifest", (t) => {
  const root = fixture(t);
  const overflow = ["index.html", ...Array.from({ length: 255 }, (_, i) => `assets/d${i}/a.js`)];
  assert.throws(() => createAssetManifest(root, overflow), /inventory exceeds/);
  const files = [...expected];
  for (let i = 0; i < 253; i++) {
    const directory = i === 0 ? "assets/d0/n1/n2" : `assets/d${i}`;
    mkdirSync(path.join(root, directory), { recursive: true });
    const file = `${directory}/a.png`;
    writeFileSync(path.join(root, file), "x");
    files.push(file);
  }
  // 255 assets + 256 distinct directories + the manifest = 512.
  assert.equal(createAssetManifest(root, files).assets.length, 255);
});

test("rejects symlink files, linked output roots and worker code", (t) => {
  const root = fixture(t);
  symlinkSync("main.js", path.join(root, "assets/link.js"));
  assert.throws(() => createAssetManifest(root, [...expected, "assets/link.js"]));
  rmSync(path.join(root, "assets/link.js"));
  const link = `${root}-link`;
  t.after(() => rmSync(link, { force: true }));
  symlinkSync(root, link);
  assert.throws(() => createAssetManifest(link, expected));
  writeFileSync(path.join(root, "assets/main.js"), "navigator.serviceWorker.register('/sw.js')");
  assert.throws(() => createAssetManifest(root, expected));
  writeFileSync(path.join(root, "assets/main.js"), "new SharedWorker('x.js')");
  assert.throws(() => createAssetManifest(root, expected));
});

test("requires every static, dynamic, CSS and asset dependency in the emitted bundle", () => {
  const metadata = () => ({ importedCss: new Set(), importedAssets: new Set() });
  const bundle = {
    // This matches Rolldown's output shape: referencedFiles is absent.
    "assets/a.js": {
      type: "chunk",
      imports: ["assets/b.js"],
      dynamicImports: ["assets/lazy.js"],
      viteMetadata: {
        importedCss: new Set(["assets/a.css"]),
        importedAssets: new Set(["assets/a.png"]),
      },
    },
    ...Object.fromEntries(
      ["assets/b.js", "assets/lazy.js"].map((name) => [
        name,
        { type: "chunk", imports: [], dynamicImports: [], viteMetadata: metadata() },
      ]),
    ),
    ...Object.fromEntries(
      ["assets/a.woff2", "assets/a.css", "assets/a.png"].map((name) => [
        name,
        { type: "asset", viteMetadata: metadata() },
      ]),
    ),
  };
  bundle["assets/a.css"].viteMetadata.importedAssets.add("assets/a.woff2");
  validateBundleClosure(bundle);
  for (const name of [
    "assets/b.js",
    "assets/lazy.js",
    "assets/a.woff2",
    "assets/a.css",
    "assets/a.png",
  ]) {
    const copy = { ...bundle };
    delete copy[name];
    assert.throws(() => validateBundleClosure(copy), name);
  }
  const external = {
    ...bundle,
    "assets/a.js": { ...bundle["assets/a.js"], dynamicImports: ["https://example.invalid/a.js"] },
  };
  assert.throws(() => validateBundleClosure(external));
  const withReferences = {
    ...bundle,
    "assets/a.js": { ...bundle["assets/a.js"], referencedFiles: ["assets/a.woff2"] },
  };
  assert.doesNotThrow(() => validateBundleClosure(withReferences));
  withReferences["assets/a.js"].referencedFiles = ["assets/missing.png"];
  assert.throws(() => validateBundleClosure(withReferences), /Missing or external/);
});

test("rejects missing or malformed bundler metadata rather than treating it as empty", () => {
  const good = () => ({
    type: "chunk",
    imports: [],
    dynamicImports: [],
    viteMetadata: { importedCss: new Set(), importedAssets: new Set() },
  });
  const verifyBad = (output) =>
    assert.throws(() => validateBundleClosure({ "assets/a.js": output }));
  for (const bad of [undefined, null, "assets/a.js", new Set(), {}]) {
    verifyBad({ ...good(), imports: bad });
    verifyBad({ ...good(), dynamicImports: bad });
  }
  for (const bad of [null, "assets/a.js", new Set(), {}]) {
    verifyBad({ ...good(), referencedFiles: bad });
  }
  for (const bad of [
    undefined,
    null,
    {},
    { importedCss: [], importedAssets: new Set() },
    { importedCss: new Set(), importedAssets: [] },
    { importedCss: new Set([null]), importedAssets: new Set() },
  ]) {
    verifyBad({ ...good(), viteMetadata: bad });
  }
  verifyBad({ type: "asset", viteMetadata: null });
  verifyBad({ type: "unknown", viteMetadata: good().viteMetadata });
  assert.throws(() => validateBundleClosure(null));
  assert.throws(() => validateBundleClosure({}));
});

test("document and stylesheet references must be external, local and listed", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "index.html"), '<script type="module">alert(1)</script>');
  assert.throws(() => createAssetManifest(root, expected));
  writeFileSync(
    path.join(root, "index.html"),
    '<script type="module" src="https://example.invalid/a.js"></script>',
  );
  assert.throws(() => createAssetManifest(root, expected));
  writeFileSync(
    path.join(root, "index.html"),
    '<script type="module" src="./assets/missing.js"></script>',
  );
  assert.throws(() => createAssetManifest(root, expected));
  writeFileSync(path.join(root, "index.html"), document());
  writeFileSync(
    path.join(root, "assets/a.css"),
    'a{background:url("https://example.invalid/a.png")}',
  );
  assert.throws(() => createAssetManifest(root, [...expected, "assets/a.css"]));
  writeFileSync(path.join(root, "assets/a.css"), 'a{background:url("./a.png")}');
  writeFileSync(path.join(root, "assets/a.png"), "png");
  assert.doesNotThrow(() =>
    createAssetManifest(root, [...expected, "assets/a.css", "assets/a.png"]),
  );
  writeFileSync(path.join(root, "assets/a.css"), '@import "./missing.css";');
  assert.throws(() => createAssetManifest(root, [...expected, "assets/a.css", "assets/a.png"]));
});

test("rejects hard links and unexpected empty directories", (t) => {
  const root = fixture(t);
  linkSync(path.join(root, "assets/main.js"), path.join(root, "assets/copy.js"));
  assert.throws(() => createAssetManifest(root, [...expected, "assets/copy.js"]));
  rmSync(path.join(root, "assets/copy.js"));
  mkdirSync(path.join(root, "assets/stale"));
  assert.throws(() => createAssetManifest(root, expected));
});

test("CSS embedded data and listed local fonts are permitted", (t) => {
  const root = fixture(t);
  writeFileSync(
    path.join(root, "assets/style.css"),
    `a{background:url("data:image/svg+xml,%3Csvg x='1 2'%3E")} @font-face{src:url('./font.woff2')}`,
  );
  writeFileSync(path.join(root, "assets/font.woff2"), "synthetic font");
  assert.doesNotThrow(() =>
    createAssetManifest(root, [...expected, "assets/style.css", "assets/font.woff2"]),
  );
  writeFileSync(path.join(root, "assets/style.css"), 'a{background:url("unterminated)}');
  assert.throws(() =>
    createAssetManifest(root, [...expected, "assets/style.css", "assets/font.woff2"]),
  );
});

test("reviewed resource-bearing markup and ambiguous document syntax fail closed", (t) => {
  const root = fixture(t);
  const cases = [
    document(moduleTag, '<img src="https://example.invalid/tracker.png">'),
    document(moduleTag, '<iframe src="./assets/missing.html"></iframe>'),
    document(moduleTag, '<div style="background-image:url(https://example.invalid/a.png)"></div>'),
    document(moduleTag + "<style>body{background:url(https://example.invalid/a)}</style>"),
    document(
      '<script type="module" src="./assets/main.js" src="https://example.invalid/a.js"></script>',
    ),
    document('<script type="module" src="./assets/main.js" onload="x()"></script>'),
    document(moduleTag + '<link rel="preload" href="./assets/main.js">'),
    document(moduleTag.replace("main.js", "main&#46;js")),
    document(
      moduleTag,
      '<main><openclaw-team-event-product></openclaw-team-event-product></main><img src="./assets/a.png">',
    ),
  ];
  for (const html of cases) {
    writeFileSync(path.join(root, "index.html"), html);
    assert.throws(() => createAssetManifest(root, expected), html);
  }
});

test("permits a closed external module, stylesheet, preload, and local CSS asset", (t) => {
  const root = fixture(t);
  writeFileSync(
    path.join(root, "index.html"),
    document(
      '<script crossorigin type="module" src="./assets/main.js"></script><link crossorigin href="./assets/style.css" rel="stylesheet"><link rel="modulepreload" href="./assets/chunk.js">',
    ),
  );
  writeFileSync(
    path.join(root, "assets/style.css"),
    'a{background:url("./a.png");content:"\\2026"}',
  );
  writeFileSync(path.join(root, "assets/chunk.js"), "export const x = 1;");
  writeFileSync(path.join(root, "assets/a.png"), "png");
  const paths = [...expected, "assets/style.css", "assets/chunk.js", "assets/a.png"];
  const manifest = createAssetManifest(root, paths);
  assert.deepEqual(
    manifest.assets.map((entry) => entry.path),
    paths.toSorted(),
  );
  assert.throws(() =>
    createAssetManifest(
      root,
      paths.filter((name) => name !== "assets/a.png"),
    ),
  );
});

test("rejects escaped CSS identifiers and URLs but accepts content escapes", (t) => {
  const root = fixture(t);
  const cssPath = path.join(root, "assets/a.css");
  const paths = [...expected, "assets/a.css"];
  for (const css of [
    '@\\69mport "https://example.invalid/a.css";',
    'a{background:u\\72l("https://example.invalid/a.png")}',
    'a{background:url("https://example.invalid/\\61.png")}',
    'a{background:image-set("https://example.invalid/a.png" 1x)}',
  ]) {
    writeFileSync(cssPath, css);
    assert.throws(() => createAssetManifest(root, paths), css);
  }
  writeFileSync(cssPath, 'a::before{content:"\\2026"}');
  assert.doesNotThrow(() => createAssetManifest(root, paths));
});

test("worker guard rejects qualified, computed and aliased capability access", (t) => {
  const root = fixture(t);
  for (const js of [
    'new Worker("x.js")',
    'new SharedWorker("x.js")',
    'new globalThis.Worker("x.js")',
    'new globalThis["Worker"]("x.js")',
    'navigator["serviceWorker"].register("x")',
    'new globalThis["Wor" + "ker"]("x.js")',
    'const g = window; const W = g["Worker"]; new W("x.js")',
    'const { Worker: W } = globalThis; new W("x.js")',
    'const key = getKey(); globalThis[key]("x.js")',
    'Reflect.get(globalThis, "Worker")',
    'new (Reflect.get.bind(Reflect)(globalThis,"Worker"))("/x")',
    'new (Reflect.get.bind(Reflect)(globalThis,"SharedWorker"))("/x")',
    'Reflect.get.bind(Reflect)(navigator,"serviceWorker").register("/x")',
    'const Worker="label"; new globalThis.Worker("/x")',
    'const Worker="label"; const g=globalThis; new g.Worker("/x")',
    'const serviceWorker="label"; const nav=navigator; nav.serviceWorker.register("/x")',
    '{ const Worker="label"; console.log(Worker); } new Worker("/x")',
    'function f(){ const Worker="label"; console.log(Worker) } new Worker("/x")',
    'const Worker="label"; function f(Worker) { return Worker }; f(other)',
    'function f(Worker) { return Worker }; f("person"); use(f)',
    'function f(Worker) { Worker=other; return Worker }; f("person")',
    "let Worker=1; Worker=globalThis.Worker; console.log(Worker)",
    'const obj={}; use(obj); console.log(obj["Worker"])',
    'const obj={}; Object.prototype.Worker=other; console.log(obj["Worker"])',
    'function f(Worker) { ({x: Worker}=other); return Worker }; f("person")',
    'export function f(Worker) { return Worker }; f("person")',
    'other.Function("return Worker")()',
    'const Worker="label"; function f(Worker) { return Worker }; f(globalThis.Worker)',
    'const labels={ Worker:"person" }; use(labels); labels["Worker"]',
    'const labels={ Worker:"person" }; labels.Worker = other; labels["Worker"]',
    'const get=Reflect.get.bind(Reflect); new (get(globalThis,"Worker"))("/x")',
    'const get=Reflect.get.bind(Reflect); new (get(globalThis,"SharedWorker"))("/x")',
    'const get=Reflect.get.bind(Reflect, globalThis, "Worker"); new (get())("/x")',
    'const get=Reflect.get.bind(Reflect); new (get.call(null, globalThis, "Worker"))("/x")',
    'const get=Reflect.get.bind(Reflect); new (get.apply(null, [globalThis, "SharedWorker"]))("/x")',
    'const get=Reflect.get.bind(Reflect); get(navigator,"serviceWorker").register("/x")',
    'function f(g,k){return new g[k]("/x")}; f(globalThis,"Worker")',
    'const f=(g,k)=>g[k]; f(globalThis,"SharedWorker")',
    'function f(g,k){return g[k]}; f(navigator,"serviceWorker")',
    '(()=>{})["constructor"]("return Worker")()',
    'const f=()=>{}; const C=f.constructor; C("return Worker")()',
    'const f=()=>{}; const g=f; const C=g.constructor; C("return Worker")()',
    'setTimeout("new Worker(1)", 1)',
    "globalThis.setInterval(`new Worker(1)`, 1)",
    'new (globalThis.Reflect.get(globalThis, "Worker"))("x")',
    'new (globalThis["Reflect"]["get"](globalThis, "Worker"))("x")',
    'const R = globalThis.Reflect; new (R.get(globalThis, "Worker"))("x")',
    '({}).constructor.constructor("return Worker")()',
    '({})["constructor"]["con" + "structor"]("return Worker")()',
    'const k = "safe"; function f(k) { return window[k]; } f("Worker")',
    'Object.getOwnPropertyDescriptor(window, "serviceWorker")',
    'const get = Reflect.get; const g = globalThis.window; get(g, "Worker")',
    "const { navigator: nav } = window; nav[getKey()]",
    'const g = Reflect.get(globalThis, "window"); g[getKey()]',
    "const { ...g } = window; g[getKey()]",
    "let g; g = window; g[getKey()]",
    'const { get } = Reflect; get(window, "Worker")',
    'const R = Reflect; R.get(window, "Worker")',
    'Object.getOwnPropertyDescriptors(window, "ignored")',
    "Reflect.ownKeys(window)",
    'let key = "safe"; key = "Worker"; window[key]("x")',
    "Object.getOwnPropertyDescriptors(window)",
    'globalThis["ev" + "al"]("code")',
    'Function("return 1")()',
    'eval("1")',
  ]) {
    writeFileSync(path.join(root, "assets/main.js"), js);
    assert.throws(() => createAssetManifest(root, expected), js);
  }
});

test("preserves equivalent quoted CSS content escapes", (t) => {
  const root = fixture(t);
  for (const rule of [
    String.raw`.event-marker::before { content: "\00b7"; }`,
    String.raw`.event-marker::before { content: "\b7"; }`,
  ]) {
    writeFileSync(path.join(root, "assets/a.css"), rule);
    assert.doesNotThrow(() => createAssetManifest(root, [...expected, "assets/a.css"]));
  }
});

test("inert worker words and comments are allowed but malformed scripts fail", (t) => {
  const root = fixture(t);
  for (const js of [
    'const label = "worker, Worker, SharedWorker and serviceWorker"; export { label };',
    '// new Worker("x") and navigator.serviceWorker\nexport const text = "co-worker";',
    "const label = `worker`; export { label };",
    "const Worker=1; console.log(Worker)",
    "const Worker=false; console.log(Worker)",
    "const Worker=null; console.log(Worker)",
    "let Worker=1; console.log(Worker)",
    "function f(Worker){ return Worker } f(1)",
    'const obj={}; console.log(obj["Worker"])',
    'const labels={ Worker:1 }; console.log(labels["Worker"])',
    "const flags={ serviceWorker:false }; console.log(flags.serviceWorker)",
    'const Worker="label"; console.log(Worker)',
    '{ const Worker="label"; console.log(Worker) }',
    'function f(){ const Worker="label"; console.log(Worker) } f()',
    'function f(Worker){ return Worker } f("person")',
    'const labels={ Worker:"person" }; console.log(labels.Worker)',
    'const labels={ "Worker":"person" }; console.log(labels["Worker"])',
    'const labels={ Worker:"person" }; { const Worker="other"; console.log(Worker, labels["Worker"]) }',
    'const workerGuide = "co-worker"; const workerNames = [workerGuide]; export { workerNames };',
    'setTimeout(() => console.log("worker"), 1);',
  ]) {
    writeFileSync(path.join(root, "assets/main.js"), js);
    assert.doesNotThrow(() => createAssetManifest(root, expected), js);
  }
  writeFileSync(path.join(root, "assets/main.js"), "export const = ;");
  assert.throws(() => createAssetManifest(root, expected), /Unparseable event JavaScript/);
});

test("asset output cannot smuggle chunk dependency metadata", () => {
  const metadata = { importedCss: new Set(), importedAssets: new Set() };
  assert.doesNotThrow(() =>
    validateBundleClosure({ "assets/a.png": { type: "asset", viteMetadata: metadata } }),
  );
  for (const field of ["imports", "dynamicImports", "referencedFiles"]) {
    for (const value of [
      [],
      ["assets/missing.js"],
      ["https://example.invalid/x.js"],
      null,
      undefined,
      "assets/a.js",
      {},
    ]) {
      assert.throws(
        () =>
          validateBundleClosure({
            "assets/a.png": { type: "asset", viteMetadata: metadata, [field]: value },
          }),
        /Invalid event asset dependency metadata/,
        `${field}: ${JSON.stringify(value)}`,
      );
      const inherited = Object.assign(Object.create({ [field]: value }), {
        type: "asset",
        viteMetadata: metadata,
      });
      assert.throws(
        () => validateBundleClosure({ "assets/a.png": inherited }),
        /Invalid event asset dependency metadata/,
        `inherited ${field}: ${JSON.stringify(value)}`,
      );
    }
  }
});

test("inert var bindings are scoped and invalidated by writes", () => {
  for (const name of ["Worker", "SharedWorker", "serviceWorker"]) {
    for (const source of [
      `var ${name}=1; use(${name})`,
      `function f(){ var ${name}=false; return ${name} }`,
      `function f(){ if (true) { var ${name}=null; } return ${name} }`,
      `function f(){ use(${name}); var ${name}=1; }`,
      `if (true) { var ${name}=1; } use(${name})`,
      `function f(){ var ${name}=1; function g(){ return ${name} } }`,
      `var ${name}=1; function f(){ let other=2; other=3 } use(${name})`,
    ]) {
      assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
    }
    for (const source of [
      `function f(){ var ${name}=1; return ${name} } use(${name})`,
      `var ${name}=1; ${name}=other; use(${name})`,
      `var ${name}=1; ${name}++; use(${name})`,
      `var ${name}=1; ({x:${name}}=other); use(${name})`,
      `var ${name}=1; [${name}]=other; use(${name})`,
      `var ${name}=1; for (${name} of other) {} use(${name})`,
      `var ${name}=1; for (${name} in other) {} use(${name})`,
      `for (var ${name} of other) { use(${name}) }`,
      `var ${name}=1; for ({x:${name}} of other) {} use(${name})`,
      `var ${name}=1; ({[${name}]:x}=other); use(${name})`,
      `var ${name}=1; obj.${name}=other; use(${name})`,
      `var ${name}=1; var ${name}=other; use(${name})`,
      `var ${name}=1; var ${name}=2; use(${name})`,
      `var ${name}; use(${name})`,
      `function f(){ { var ${name}=1; } ${name}=other; return ${name} }`,
    ]) {
      assert.throws(() => validateWorkerCapabilities(source), source);
    }
  }
});

test("class static blocks isolate lexical and var worker bindings", () => {
  for (const name of ["Worker", "SharedWorker", "serviceWorker"]) {
    for (const kind of ["var", "let", "const"]) {
      for (const source of [
        `class C { static { ${kind} ${name}=1; use(${name}) } }`,
        `class C { static { ${kind} ${name}=1; function f(){ return ${name} } f() } }`,
        `class C { static { ${kind} ${name}=1; { use(${name}) } } }`,
        `function outer(){ class C { static { ${kind} ${name}=1; use(${name}) } } }`,
      ]) {
        assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
      }
      for (const source of [
        `class C { static { ${kind} ${name}=1; } } use(${name})`,
        `class C { static { ${kind} ${name}=1; } static { use(${name}) } }`,
        `function outer(){ class C { static { ${kind} ${name}=1; } } use(${name}) }`,
        `class C { static { function f(){ ${kind} ${name}=1; return ${name} } use(${name}) } }`,
        `class C { static { ${kind} ${name}=1; ${name}=other; use(${name}) } }`,
        `class C { static { ${kind} ${name}=1; function f(){ ${name}=other } use(${name}) } }`,
        `class C { static { ${kind} ${name}=1; use(globalThis.${name}) } }`,
        `class C { static { ${kind} ${name}=1; Reflect.get(globalThis,"${name}") } }`,
      ]) {
        assert.throws(() => validateWorkerCapabilities(source), source);
      }
    }
    for (const source of [
      `class C { static { if (true) { var ${name}=1 } use(${name}) } }`,
      `let ${name}=1; class C { static { var ${name}=2; use(${name}) } } use(${name})`,
      `class C { static { var ${name}=1; function f(){ let ${name}=2; return ${name} } use(${name}) } }`,
    ]) {
      assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
    }
    for (const source of [
      `class C { static { var ${name}=1; var ${name}=2; use(${name}) } }`,
      `class C { static { if (true) { var ${name}=1 } } static { use(${name}) } }`,
      `class C { static { var ${name}=1; } method(){ use(${name}) } }`,
      `class C { static { var ${name}=1; } } const g=globalThis; use(g["${name}"])`,
    ]) {
      assert.throws(() => validateWorkerCapabilities(source), source);
    }
  }
});

test("capability aliases stay with their lexical binding", () => {
  for (const source of [
    'const t=globalThis; function harmless(t,n){return Object.getOwnPropertyDescriptor(t,n)} harmless({x:1},"x")',
    "const n=Reflect.get,o=globalThis; function W(e,t,n,r){let o={active:()=>true,rows:[]};n(o)}",
    "const t=globalThis; function f(t){return Object.keys(t)} function g(t){return t[key]} f({});g({})",
    "const t=globalThis; { const t={}; Object.keys(t) }",
    "const t=globalThis; try {} catch(t) { Object.keys(t) }",
    "const t=globalThis; for (const t of objects) Object.keys(t)",
    "const t=globalThis; switch(x){case 1: let t={};Object.keys(t)}",
    "function f(){var t=globalThis} function g(){if(x){var t={}}Object.keys(t)}",
    "class C { static { var t=globalThis } static { var t={};Object.keys(t) } }",
    "const t=globalThis; function f(t){t={};return t[key]}",
    "const get=Reflect.get; function f(get){get(window,key)}",
    "const R=Reflect; function f(R){R[key](window,key)}",
    "function f(globalThis,window,self,navigator,Reflect,Object){globalThis[key];window[key];self[key];navigator[key];Reflect[key];Object[key]}",
    "unknown[key];other[key];Object.keys(unknown)",
    'import { value as globalThis } from "local"; globalThis[key]',
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
  for (const source of [
    "const t=globalThis; function f(){return t[key]}",
    "let t; t=globalThis; t={};Object.keys(t)",
    "let t; {t=globalThis} Object.keys(t)",
    "globalThis[key]; unknown[key]",
    "function f(globalThis){return globalThis[key]} f(window)",
    "function f(){if(x){var t=globalThis} Object.keys(t)}",
    "function f(){Object.keys(t);var t=globalThis}",
    "var t=globalThis;var t={};Object.keys(t)",
    "function f(t){var t;return t[key]} f(globalThis)",
    "class C {static {if(x){var t=globalThis}Object.keys(t)}}",
    "const {navigator:n}=globalThis; n[key]",
    'const {["navigator"]:n}=globalThis; n[key]',
    'const {get:g}=Reflect; g(window,"Worker")',
    'let R;R=Reflect;R={};R.get(window,"Worker")',
    'let get;get=Reflect.get;get=other;get(window,"Worker")',
    'function f(R,g){return R.get(g,"Worker")}f(Reflect,window)',
    'function f(get,g){return get(g,"Worker")}f(Reflect.get,window)',
    "(g=>g[key])(globalThis)",
    "function f(g){if(x)f(g);return g[key]} f(globalThis)",
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
});

test("function aliases retain all targets without tainting same-named locals", () => {
  for (const source of [
    "function f(){};function g(f){return f.constructor}g({})",
    "function f(f){return f.constructor} f({})",
    "function outer(){function f(g){return g[key]}} function f(g){return 1}f(window)",
    "const f=()=>{}; {const f={};f.constructor}",
    "const f=function named(named){return named.constructor};f({})",
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
  for (const source of [
    "function f(f){return f[key]} f(globalThis)",
    'function f(f){return 1} f.constructor("code")',
    "function f(g){return g[key]}const h=f;h(globalThis)",
    "let f;f=g=>g[key];f(globalThis)",
    "function safe(){} function dangerous(g){return g[key]} let f=safe;f=dangerous;f(globalThis)",
    "function dangerous(g){return g[key]} function safe(){} let f=dangerous;f=safe;f(globalThis)",
    "var f=g=>g[key];var f=()=>{};f(globalThis)",
    'let f;f=()=>{};f={};f.constructor("code")',
    "function use(f){return f.constructor}use(()=>{})",
    "const f=function named(){return named.constructor};f()",
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
});

test("constant strings and writes resolve independently across scopes", () => {
  for (const source of [
    'const key="Worker";function f(){const key="label";return obj[key]}',
    'const callback="code";function f(callback){setTimeout(callback,1)}f(()=>{})',
    'const key="label";function f(key){key="Worker"}obj[key]',
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
  for (const source of [
    'const key="label";function f(){const key="Worker";return obj[key]}',
    'const key="Worker";function f(key){key="label"}obj[key]',
    'const callback="code";function f(){const callback="other"}setTimeout(callback,1)',
    'const key="safe";globalThis[key]',
    'let key="safe";key=other;globalThis[key]',
    'const key="safe";Reflect[key](globalThis,"safe")',
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
});

test("lexical correction preserves conservative code-generation and convergence denials", () => {
  for (const source of [
    "const obj={eval:1};obj.eval",
    'const f=()=>{};const g=f;g.constructor("code")',
    '({}).constructor.constructor("code")',
    'const get=Reflect.get.bind(Reflect);get.call(null,window,"safe")',
    'const get=Reflect.get.bind(Reflect,window,"safe");get()',
    'const obj={};Object.prototype.Worker=other;obj["Worker"]',
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
  const chain = [
    "const a0=globalThis;",
    ...Array.from({ length: 40 }, (_, i) => `const a${i + 1}=a${i};`),
  ].join("");
  assert.throws(() => validateWorkerCapabilities(chain), /Unresolved event JavaScript aliases/);
});

test("catch initializers and default parameters preserve their runtime binding", () => {
  for (const source of [
    "function f(){var t;try{throw {}}catch(t){var t=globalThis;t[getKey()]}}",
    "try{}catch(g){var g=globalThis;Object.keys(g)}",
    'try{}catch(f){var f=()=>{};f.constructor("code")}',
    "try{}catch(g){var {navigator:g}=globalThis;g[key]}",
    'try{}catch(get){var {get}=Reflect;get(window,"Worker")}',
    "function f(x=globalThis[key]){var globalThis={}}f()",
    "function f(x=Reflect.get(window,key)){var Reflect={};var window={}}f()",
    "function f(x=globalThis[key]){function globalThis(){}}f()",
    "function f(x=globalThis[key]){var globalThis;function g(){}}f()",
    "function f(t,x=0){var t;return t[key]}f(globalThis)",
    'function f(get,x=0){var get;return get(window,"Worker")}f(Reflect.get)',
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
  for (const source of [
    "var t={};try{}catch(t){var t=globalThis}Object.keys(t)",
    "function f(x=Object.keys(t)){var t=globalThis}f()",
    "const f=function named(named){return named[key]};f({})",
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
});

test("inert enum property writes do not read Function or eval capabilities", () => {
  for (const source of [
    'const e={};e[e.Function=5]="Function"',
    'var kinds;(function(e){e[e.Function=5]="Function"})(kinds||={})',
    'const data={};data.Function=5;data.eval="label"',
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
  for (const source of [
    'other.Function("return Worker")()',
    'other.eval("new Worker(1)")',
    'const F=other.Function;F("code")',
    "other.Function+=5",
    "other.Function++",
    "other.Function=unknown",
    "other.Function=Function",
    "other.Function=eval",
    "globalThis.Function=5",
    "const g=window;g.Function=5",
    'globalThis["Function"]=5',
    'globalThis["Fun"+"ction"]("code")',
    'const key="Function";globalThis[key]("code")',
    'const F=Function;F("code")',
    'const E=eval;E("code")',
    'Reflect.get(globalThis,"Function")',
    "let g={};g=globalThis;g.Function=5",
    'import {Function as F} from "external";F("code")',
    'import {eval as E} from "external";E("code")',
    'const {Function:F}=other;F("code")',
    '(()=>{}).constructor("code")',
    'const data={};data.Function=5;data.Function("code")',
    'new Worker("x")',
    'const W=globalThis.Worker;new W("x")',
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
});

test("switch discriminants use the enclosing scope before case bindings", () => {
  for (const source of [
    "switch(globalThis[key]){case 1:let globalThis={};}",
    "const g=globalThis;switch(g[key]){case 1:let g={};}",
    'switch(Reflect.get(window,"Worker")){case 1:let Reflect={};}',
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
  for (const source of [
    "switch(1){case 1:let globalThis={};globalThis[key]}",
    "const g=globalThis;switch(1){case 1:let g={};g[key]}",
    'switch(1){case 1:let Reflect={};Reflect.get({},"label")}',
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
});

test("parameter patterns retain recognizable capability sources", () => {
  for (const source of [
    "function f(globalThis=window){return globalThis[key]}f()",
    'function f(Reflect=globalThis.Reflect){return Reflect.get(window,"Worker")}f()',
    "function f(globalThis={}){return globalThis[key]}f(window)",
    "function f({window}){return window[key]}f(globalThis)",
    'function f({"window":g}){return g[key]}f(globalThis)',
    'const f=function named(g=named){return g.constructor("code")};f()',
    'function f({Reflect:R}){return R.get(window,"Worker")}f(globalThis)',
    'function f({get:g}){return g(window,"Worker")}f(Reflect)',
    "function f({[key]:g}){return g[key]}f(globalThis)",
    "function f({...g}){return g[key]}f(globalThis)",
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
  for (const source of [
    "function f(globalThis={}){return globalThis[key]}f()",
    'function f(Reflect={}){return Reflect.get({},"label")}f()',
    "function f({window}){return window[key]}f({window:{}})",
    "function f({window:g}={}){return g[key]}f({})",
    "const f=function named(g={}){return g.constructor};f()",
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
});

test("declarations and parameters preserve nested and defaulted capabilities", () => {
  for (const source of [
    "function f(){const {window={}}=globalThis;window[key]}f()",
    "function f(){const {window:{self}}=globalThis;self[key]}f()",
    'function f(globalThis=Reflect.get(window,"window")){return globalThis[key]}f()',
    'const {window:{self:g}={}}=Reflect.get(window,"window");g[key]',
    'const {Reflect:{get:g=()=>{}}}=globalThis;g(window,"Worker")',
    'const {get:g=()=>{}}=Reflect;g(window,"Worker")',
    "const {window:{[key]:g}}=globalThis;g()",
    "const {window:{...g}}=globalThis;g[key]",
    "const [g]=window;g[key]",
    "const {label:g=window}={};g[key]",
    "const [g=window]=[];g[key]",
    "function f([g=window]){g[key]}f([])",
    'function f(g){g[key]}f(Reflect.get(window,"self"))',
    "let g;({window:{self:g}}=globalThis);g[key]",
    "try{}catch(g){var {window:g={}}=globalThis;g[key]}",
    "try{}catch(g){var {window:{self:g}}=globalThis;g[key]}",
    "try{}catch(g){var {label:g=window}={};g[key]}",
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
  for (const source of [
    "const {window={}}={};window[key]",
    "const {window:{self}}={window:{self:{}}};self[key]",
    'function f(g=Reflect.get({window:{}},"window")){return g[key]}f()',
    'function f(Reflect){const g=Reflect.get(window,"window");g[key]}f({})',
    "const {label:g={}}={};g[key]",
    "const [g={}]=[];g[key]",
    "var g={};try{}catch(g){var {window:g={}}=globalThis}Object.keys(g)",
    "var g={};try{}catch(g){var {label:g=window}={}}Object.keys(g)",
    "const {...g}={};g[key]",
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
});

test("catch and loop binding defaults retain recognizable capabilities", () => {
  for (const source of [
    "try{throw {}}catch({window=globalThis}){window[key]}",
    "try{throw {x:{}}}catch({x:{self=window}}){self[key]}",
    "try{throw []}catch([g=window]){g[key]}",
    'try{throw {}}catch({r=Reflect}){r.get(window,"Worker")}',
    'try{throw {}}catch({f=()=>{}}){f.constructor("x")}',
    'try{throw {}}catch({g=Reflect.get(window,"window")}){g[key]}',
    "let window;for({x:window=globalThis} of [{}]){window[key]}",
    "let g;for({x:g=window} of [{}]){g[key]}",
    "let g;for({x:g=window} in {item:1}){g[key]}",
    "let g;for([g=window] of [[]]){g[key]}",
    "for(const {x:g=window} of [{}]){g[key]}",
  ]) {
    assert.throws(
      () => validateWorkerCapabilities(source),
      /Worker capability unavailable/,
      source,
    );
  }
  for (const source of [
    "try{throw {}}catch({window={}}){window[key]}",
    "try{throw {x:{}}}catch({x:{self={}}}){self[key]}",
    "try{throw []}catch([g={}]){g[key]}",
    'try{throw {}}catch({r={}}){r.get({},"label")}',
    "try{throw {}}catch({f={}}){f.constructor}",
    "let g;for({x:g={}} of [{}]){g[key]}",
    "let g;for({x:g={}} in {item:1}){g[key]}",
    "let g;for([g={}] of [[]]){g[key]}",
    "for(const {x:g={}} of [{}]){g[key]}",
  ]) {
    assert.doesNotThrow(() => validateWorkerCapabilities(source), source);
  }
});
