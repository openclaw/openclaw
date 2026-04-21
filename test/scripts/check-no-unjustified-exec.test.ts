import { describe, expect, it } from "vitest";
import {
  CHILD_PROCESS_IMPORT_SOURCES,
  EXEC_IMPORT_ALLOWLIST,
  findExecImportViolations,
  findShellTrueViolations,
  SHELL_TRUE_ALLOWLIST,
} from "../../scripts/check-no-unjustified-exec.mjs";

describe("check-no-unjustified-exec", () => {
  it("flags exec imports from node:child_process", () => {
    const source = `import { exec } from "node:child_process";\nexec("ls");`;
    expect(findExecImportViolations(source)).toEqual([{ bindings: ["exec"] }]);
  });

  it("flags execSync imports from child_process", () => {
    const source = `import { execSync } from "child_process";\n`;
    expect(findExecImportViolations(source)).toEqual([{ bindings: ["execSync"] }]);
  });

  it("flags multi-name imports when at least one is risky", () => {
    const source = `import { spawn, execSync, execFile } from "node:child_process";\n`;
    const violations = findExecImportViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.bindings).toEqual(["execSync"]);
  });

  it("ignores child_process imports that only pull safe bindings", () => {
    const source = `import { spawn, spawnSync, execFile, execFileSync } from "node:child_process";\n`;
    expect(findExecImportViolations(source)).toEqual([]);
  });

  it("ignores unrelated imports that look similar", () => {
    const source = `import { execSync } from "./my-fake-child-process";\n`;
    expect(findExecImportViolations(source)).toEqual([]);
  });

  it("handles renamed bindings (`as` form)", () => {
    const source = `import { execSync as runSync } from "node:child_process";\n`;
    expect(findExecImportViolations(source)).toEqual([{ bindings: ["execSync"] }]);
  });

  it("handles multi-line import blocks", () => {
    const source = `import {\n  spawn,\n  execSync,\n} from "node:child_process";\n`;
    expect(findExecImportViolations(source)).toEqual([{ bindings: ["execSync"] }]);
  });

  it("flags shell: true usage", () => {
    const source = `spawn("x", [], { shell: true });`;
    expect(findShellTrueViolations(source)).toBe(1);
  });

  it("counts multiple shell: true occurrences", () => {
    const source = `
      spawn("x", [], { shell: true });
      spawnSync("y", [], { shell:true });
    `;
    expect(findShellTrueViolations(source)).toBe(2);
  });

  it("does not match shell: false or shell: variable", () => {
    const source = `spawn("x", [], { shell: false }); spawn("y", [], { shell });`;
    expect(findShellTrueViolations(source)).toBe(0);
  });

  it("exposes the import source list and allowlists as named exports", () => {
    expect(CHILD_PROCESS_IMPORT_SOURCES).toContain("node:child_process");
    expect(CHILD_PROCESS_IMPORT_SOURCES).toContain("child_process");
    expect(EXEC_IMPORT_ALLOWLIST.length).toBeGreaterThan(0);
    expect(SHELL_TRUE_ALLOWLIST.length).toBeGreaterThan(0);
  });
});
