// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(uiSource, "../..");

function stylesheets(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") {
      return [];
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return stylesheets(file);
    }
    return entry.name.endsWith(".css") ? [file] : [];
  });
}

const owner = path.join(uiSource, "styles/base.css");
const sheets = [...stylesheets(uiSource), ...stylesheets(path.join(repoRoot, "extensions"))].map(
  (file) => ({ file, css: fs.readFileSync(file, "utf8") }),
);
const others = sheets.filter(({ file }) => file !== owner);
const offenders = (pattern: RegExp) =>
  others.filter(({ css }) => pattern.test(css)).map(({ file }) => path.relative(repoRoot, file));

describe("Control UI shimmer ownership", () => {
  it("declares each sweep once, in base.css", () => {
    const base = fs.readFileSync(owner, "utf8");
    for (const name of ["shimmer", "text-shimmer"]) {
      expect(base.match(new RegExp(`@keyframes ${name} `, "g"))).toHaveLength(1);
    }
    expect(offenders(/@keyframes (?:[\w-]+-)?(?:shimmer|sweep) /u).filter(isSweep)).toEqual([]);
  });

  it("keeps text clipping and sweep tokens in the shared classes", () => {
    expect(offenders(/background-clip:\s*text/u)).toEqual([]);
    expect(offenders(/--skeleton-(?:duration|easing|highlight|sweep)|--text-shimmer-/u)).toEqual(
      [],
    );
  });

  it("keeps Carapace skeleton lines on the shared placeholder base", () => {
    const carapace = fs.readFileSync(path.join(uiSource, "styles/carapace-control-ui.css"), "utf8");
    expect(carapace).toContain(".oc-skeleton-line {");
    expect(carapace).not.toMatch(/\.oc-skeleton-line[^{]*\{[^}]*background/u);
  });

  it("keeps raised placeholder surfaces on the raised base", () => {
    for (const sheet of [
      "activity.css",
      "chat/composer.css",
      "memory-import.css",
      "panel-loading-skeleton.css",
      "settings.css",
    ]) {
      const css = fs.readFileSync(path.join(uiSource, "styles", sheet), "utf8");
      expect(css, sheet).toContain("--skeleton-base: var(--skeleton-base-raised);");
    }
    const activity = fs.readFileSync(path.join(uiSource, "styles/activity.css"), "utf8");
    expect(activity).toMatch(
      /\.activity-pulse--loading \{[^}]*background: var\(--skeleton-base\);/u,
    );
  });
});

// Decorative glows named "shimmer" animate opacity or filter on artwork, not a sweep.
function isSweep(file: string): boolean {
  const css = fs.readFileSync(path.join(repoRoot, file), "utf8");
  return /@keyframes (?:[\w-]+-)?(?:shimmer|sweep) \{[^@]*?(?:background-position|translateX)/u.test(
    css,
  );
}
