// Isolated browser decode cost for exported synthetic cold-load snapshots.
// Run from the candidate root: <base-root> <base-snapshot.json> <candidate-snapshot.json> <output.json>.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { build } from "vite";
import * as json from "../src/lib/snapshot-json.ts";

const [baseRoot, baseInput, candidateInput, output] = process.argv.slice(2);
if (!baseRoot || !baseInput || !candidateInput || !output)
  throw new Error("Expected four decode comparison paths");
const transport = json.object({
  records: json.array(json.object({ sessionKey: json.text, model: json.unknown })),
  blobs: json.array(
    json.object({
      sessionKey: json.text,
      index: json.number,
      type: json.text,
      bytes: json.array(json.number),
    }),
  ),
});
const inputs = await Promise.all(
  [baseInput, candidateInput].map(async (file) =>
    transport.parse(JSON.parse(await readFile(file, "utf8"))),
  ),
);
const scripts: string[] = [];
for (const root of [baseRoot, process.cwd()]) {
  const built = await build({
    configFile: false,
    root,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(root, "ui/src/components/sidebar-snapshot-data.ts"),
        formats: ["iife"],
        name: "SidebarSnapshotDecoder",
      },
    },
  });
  const bundle = Array.isArray(built) ? built[0] : built;
  if (!bundle || !("output" in bundle)) throw new Error("Expected an in-memory decoder bundle");
  const entry = bundle.output.find((item) => item.type === "chunk" && item.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Decoder bundle has no entry");
  scripts.push(entry.code);
}
const browser = await chromium.launch({ headless: true });
const samples: Array<{ pair: number; variant: string; schemaMs: number; imageDecodeMs: number }> =
  [];
try {
  for (let pair = 1; pair <= 11; pair++) {
    for (const variant of pair % 2 ? [0, 1] : [1, 0]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.addScriptTag({ content: scripts[variant]! });
        const cost = await page.evaluate(async (input) => {
          if (input.records.length !== 1) throw new Error("Expected one fixture sidebar owner");
          const record = input.records[0]!;
          const model = record.model;
          if (typeof model !== "object" || model === null) throw new Error("Missing sidebar model");
          const images: Blob[] = [];
          for (const image of input.blobs) {
            const targets: unknown = Reflect.get(model, "avatarImages");
            const target: unknown = Array.isArray(targets) ? targets[image.index] : undefined;
            if (
              image.sessionKey !== record.sessionKey ||
              typeof target !== "object" ||
              target === null
            ) {
              throw new Error("Image lost its fixture snapshot owner");
            }
            const blob = new Blob([new Uint8Array(image.bytes)], { type: image.type });
            Reflect.set(target, "blob", blob);
            images.push(blob);
          }
          const decoder: unknown = Reflect.get(window, "SidebarSnapshotDecoder");
          if (
            typeof decoder !== "object" ||
            decoder === null ||
            !("parseSidebarSnapshot" in decoder) ||
            typeof decoder.parseSidebarSnapshot !== "function"
          )
            throw new Error("Missing source decoder");
          const start = performance.now();
          const parsed: unknown = decoder.parseSidebarSnapshot(model);
          const schemaMs = performance.now() - start;
          if (!parsed) throw new Error("Source decoder rejected its own fixture snapshot");
          const imageStart = performance.now();
          const urls: string[] = [];
          try {
            const sources = images.map((blob) => {
              const url = URL.createObjectURL(blob);
              urls.push(url);
              return url;
            });
            const stored: unknown = Reflect.get(model, "avatarImages");
            if (Array.isArray(stored)) {
              for (const image of stored) {
                const dataUrl: unknown =
                  typeof image === "object" && image !== null
                    ? Reflect.get(image, "dataUrl")
                    : undefined;
                if (typeof dataUrl === "string") sources.push(dataUrl);
              }
            }
            await Promise.all(
              sources.map(async (source) => {
                const image = new Image();
                image.src = source;
                await image.decode();
              }),
            );
            return { schemaMs, imageDecodeMs: performance.now() - imageStart };
          } finally {
            urls.forEach((url) => URL.revokeObjectURL(url));
          }
        }, inputs[variant]!);
        samples.push({ pair, variant: variant === 0 ? "base" : "candidate", ...cost });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  output,
  JSON.stringify(
    {
      measurement:
        "11 interleaved pairs, fresh browser contexts, actual source schema decode. Image decode covers stored Blobs and data URLs; a snapshot without stored images has no image preparation work here. Excludes IDB I/O, transport materialization, HTTP image fetching and UI mount. Not navigation timing.",
      samples,
    },
    null,
    2,
  ),
);
