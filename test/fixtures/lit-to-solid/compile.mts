import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertLitToSolid } from "../../../scripts/codemods/lit-to-solid.mts";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import { corpus, fixtureSource } from "./corpus.mts";

// This artifact is consumed by tsgo on the task's remote proof host.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.resolve(root, ".artifacts/solid2-p1-12/corpus");
fs.mkdirSync(output, { recursive: true });
using parser = createNativeTypeScriptParser({ cwd: root });
function writeConverted(name: string, source: string) {
  const result = convertLitToSolid(source, `${name}.ts`, parser);
  if (result.diagnostics.length) {
    throw new Error(`${name}: ${JSON.stringify(result.diagnostics)}`);
  }
  fs.writeFileSync(path.join(output, `${name}.tsx`), result.code);
}
for (const fixture of corpus) {
  writeConverted(fixture.id, fixtureSource(fixture));
}
writeConverted(
  "narrowed-and-boolean",
  'import {html,nothing} from "lit"; declare const user: {name: string} | undefined; declare const values: boolean[]; declare const rtl:boolean; declare const role:"button"|"link"; export const fixture=html`<div dir=${rtl ? "rtl" : "ltr"} role=${role}>${user ? user.name : nothing}${values}</div>`;',
);
writeConverted(
  "intrinsic-names",
  'import {html} from "lit"; const String=()=>"wrong"; const Array={from:()=>[]}; const Symbol={iterator:"wrong"}; type Node=never; type Iterable<T>=never; export const fixture=html`<div title data-value=${123}>${[true,false]}</div>`;',
);
writeConverted(
  "callable-template",
  'import {html, type TemplateResult} from "lit"; export function view(draw:()=>TemplateResult){return html`<section>${draw()}</section>`;}',
);
fs.copyFileSync(
  new URL("./custom-elements.d.ts", import.meta.url),
  path.join(output, "custom-elements.d.ts"),
);
fs.writeFileSync(
  path.join(output, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
        jsxImportSource: "@solidjs/web",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        paths: {
          "@solidjs/web": [path.join(root, "ui/node_modules/@solidjs/web")],
          "@solidjs/web/jsx-runtime": [
            path.join(root, "ui/node_modules/@solidjs/web/types/jsx.d.ts"),
          ],
          "solid-js": [path.join(root, "ui/node_modules/solid-js")],
        },
      },
      include: ["*.tsx", "custom-elements.d.ts"],
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared ${corpus.length} converted templates in ${path.relative(root, output)}`);
