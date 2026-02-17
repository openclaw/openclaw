import { describe, expect, it } from "vitest";
import { scanSourceAst } from "./skill-scanner-ast.js";

describe("skill-scanner-ast", () => {
  // -----------------------------------------------------------------------
  // Dynamic import
  // -----------------------------------------------------------------------

  it("flags dynamic import with variable specifier", () => {
    const source = `const mod = getModuleName();\nawait import(mod);`;
    const findings = scanSourceAst(source, "test.ts");
    expect(findings.some((f) => f.ruleId === "dynamic-import")).toBe(true);
  });

  it("ignores static string import", () => {
    const source = `await import("./safe-module.js");`;
    const findings = scanSourceAst(source, "test.ts");
    expect(findings.some((f) => f.ruleId === "dynamic-import")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Dynamic require
  // -----------------------------------------------------------------------

  it("flags require with variable argument", () => {
    const source = `const name = "child" + "_process";\nconst cp = require(name);`;
    const findings = scanSourceAst(source, "test.js");
    expect(findings.some((f) => f.ruleId === "dynamic-require")).toBe(true);
  });

  it("ignores static require", () => {
    const source = `const fs = require("fs");`;
    const findings = scanSourceAst(source, "test.js");
    expect(findings.some((f) => f.ruleId === "dynamic-require")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Indirect eval
  // -----------------------------------------------------------------------

  it("flags globalThis['eval'](...)", () => {
    const source = `globalThis["eval"]("alert(1)");`;
    const findings = scanSourceAst(source, "test.ts");
    expect(findings.some((f) => f.ruleId === "indirect-eval")).toBe(true);
  });

  it("flags (0, eval)(...) pattern", () => {
    const source = `(0, eval)("alert(1)");`;
    const findings = scanSourceAst(source, "test.ts");
    expect(findings.some((f) => f.ruleId === "indirect-eval")).toBe(true);
  });

  it("flags computed Function access", () => {
    const source = `const fn = globalThis["Function"]("return 1");\nfn();`;
    const findings = scanSourceAst(source, "test.ts");
    expect(findings.some((f) => f.ruleId === "indirect-eval")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Prototype pollution
  // -----------------------------------------------------------------------

  it("flags __proto__ assignment", () => {
    const source = `const obj = {};\nobj.__proto__.polluted = true;`;
    const findings = scanSourceAst(source, "test.ts");
    expect(findings.some((f) => f.ruleId === "prototype-pollution")).toBe(true);
  });

  it("flags constructor.prototype assignment", () => {
    const source = `obj.constructor.prototype.isAdmin = true;`;
    const findings = scanSourceAst(source, "test.ts");
    expect(findings.some((f) => f.ruleId === "prototype-pollution")).toBe(true);
  });

  it("flags bracket notation __proto__", () => {
    const source = `const obj = {};\nobj["__proto__"]["polluted"] = true;`;
    const findings = scanSourceAst(source, "test.ts");
    expect(findings.some((f) => f.ruleId === "prototype-pollution")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Integration: regex bypass that AST catches
  // -----------------------------------------------------------------------

  it("catches concatenated require that evades regex", () => {
    // This bypasses the regex pattern for child_process detection
    const source = `const m = "child_" + "process";\nconst cp = require(m);\ncp.exec("whoami");`;
    const findings = scanSourceAst(source, "test.js");
    expect(findings.some((f) => f.ruleId === "dynamic-require")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("returns empty array for unparseable source", () => {
    const findings = scanSourceAst("}{not valid at all{{", "broken.ts");
    expect(findings).toEqual([]);
  });

  it("deduplicates findings per ruleId", () => {
    const source = `require(a);\nrequire(b);\nrequire(c);`;
    const findings = scanSourceAst(source, "test.js");
    const requireFindings = findings.filter((f) => f.ruleId === "dynamic-require");
    expect(requireFindings).toHaveLength(1);
  });

  it("handles TSX files", () => {
    const source = `const mod = getModule();\nawait import(mod);\nconst App = () => <div />;`;
    const findings = scanSourceAst(source, "component.tsx");
    expect(findings.some((f) => f.ruleId === "dynamic-import")).toBe(true);
  });
});
