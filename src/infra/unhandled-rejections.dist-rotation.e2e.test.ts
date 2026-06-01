import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDistModuleRotationError } from "./unhandled-rejections.js";

// Pins the classifier against GENUINE native-Node ESM error output. vitest's module
// runner transforms imports and does not enforce ESM named-export linking, so the real
// #88857 SyntaxError (and its stack shape) is harvested from a child process under the
// native loader. The handler's exit/skip-fatal-hooks branch is covered separately in
// unhandled-rejections.fatal-detection.test.ts.
type HarvestedError = { name: string; code?: string; message: string; stack: string };

function harvest(dir: string, targetUrl: string): HarvestedError {
  const out = execFileSync(process.execPath, [path.join(dir, "harvest.mjs"), targetUrl], {
    encoding: "utf8",
  });
  return JSON.parse(out) as HarvestedError;
}

function asError(h: HarvestedError): Error {
  const error = Object.assign(new SyntaxError(h.message), { stack: h.stack });
  Object.defineProperty(error, "name", { value: h.name, configurable: true });
  return error;
}

let dir: string;
let realRotation: Error; // openclaw/dist chunk imports its own rotated runtime boundary
let realThirdParty: Error; // openclaw/dist host dynamically imports a third-party broken runtime

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ocrot-"));
  const ocDist = path.join(dir, "node_modules", "openclaw", "dist");
  const pluginDist = path.join(dir, "node_modules", "some-plugin", "dist");
  mkdirSync(ocDist, { recursive: true });
  mkdirSync(pluginDist, { recursive: true });

  // #88857: in-memory chunk expects export `a`; the rebuilt boundary now exports `b`.
  writeFileSync(path.join(ocDist, "x.runtime.mjs"), "export const b = 1;\n");
  writeFileSync(
    path.join(ocDist, "importer.mjs"),
    'import { a } from "./x.runtime.mjs";\nexport const z = a;\n',
  );

  // ClawSweeper overmatch shape: third-party importer, openclaw only an async caller.
  writeFileSync(path.join(pluginDist, "runtime.mjs"), "export const y = 1;\n");
  writeFileSync(
    path.join(pluginDist, "index.mjs"),
    'import { n } from "./runtime.mjs";\nexport const z = n;\n',
  );
  writeFileSync(
    path.join(ocDist, "host.mjs"),
    'await import("../../some-plugin/dist/index.mjs");\n',
  );

  writeFileSync(
    path.join(dir, "harvest.mjs"),
    [
      "try { await import(process.argv[2]); process.stdout.write(JSON.stringify({ ok: true })); }",
      "catch (e) { process.stdout.write(JSON.stringify({ name: e.name, code: e.code, message: e.message, stack: e.stack })); }",
    ].join("\n") + "\n",
  );

  realRotation = asError(harvest(dir, pathToFileURL(path.join(ocDist, "importer.mjs")).href));
  realThirdParty = asError(harvest(dir, pathToFileURL(path.join(ocDist, "host.mjs")).href));
}, 30_000);

afterAll(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dist module rotation (real Node ESM stacks)", () => {
  it("produced the genuine #88857 SyntaxError shape", () => {
    expect(realRotation.name).toBe("SyntaxError");
    expect(realRotation.message).toContain("does not provide an export named");
    // The importer (our own dist chunk) is the leading code-frame line.
    expect((realRotation.stack ?? "").split("\n")[0]).toMatch(/[/\\]openclaw[/\\]dist[/\\]/);
  });

  it("classifies our own rotated runtime boundary as a dist rotation", () => {
    expect(isDistModuleRotationError(realRotation)).toBe(true);
  });

  it("does NOT classify a third-party runtime mismatch our dist merely async-imported", () => {
    // Real stack: importer is some-plugin/dist; openclaw/dist appears only as an `at async`
    // caller below the leading code-frame.
    expect((realThirdParty.stack ?? "").split("\n")[0]).toMatch(/some-plugin[/\\]dist[/\\]/);
    expect(realThirdParty.stack ?? "").toMatch(/openclaw[/\\]dist[/\\]/); // openclaw IS in the stack
    expect(isDistModuleRotationError(realThirdParty)).toBe(false);
  });
});
