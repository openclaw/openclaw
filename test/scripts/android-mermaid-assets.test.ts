import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const buildFile = "apps/android/app/build.gradle.kts";

describe("Native Mermaid asset generation", () => {
  it.each(["pele", "dompurify"])(
    "identifies the pinned %s version in redistributed notices",
    (name) => {
      const { dependencies } = JSON.parse(
        readFileSync("packages/mermaid-renderer/package.json", "utf8"),
      );
      const notice = readFileSync("packages/mermaid-renderer/native/NOTICE.txt", "utf8");
      expect(notice.toLowerCase()).toContain(`${name} ${dependencies[name]} —`);
    },
  );

  it("builds through the package-local pnpm context", () => {
    const build = readFileSync(buildFile, "utf8");
    const task = build.slice(
      build.indexOf('tasks.register<Exec>("generateMermaidAssets")'),
      build.indexOf('tasks.matching { task -> task.name == "preBuild" }'),
    );

    expect(task).toContain('commandLine("pnpm", "--dir", "packages/mermaid-renderer", "build")');
    expect(task).not.toContain(
      'commandLine("pnpm", "--filter", "@openclaw/mermaid-renderer", "build")',
    );
  });
});
