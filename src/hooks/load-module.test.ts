import { describe, expect, it } from "vitest";
import { getHandlerFromModule, isCjsInEsmError } from "./load-module.js";

describe("isCjsInEsmError", () => {
  it("returns true for 'module is not defined'", () => {
    expect(isCjsInEsmError(new Error("module is not defined in ES module scope"))).toBe(true);
  });

  it("returns true for 'require is not defined'", () => {
    expect(isCjsInEsmError(new Error("require is not defined in ES module scope"))).toBe(true);
  });

  it("returns true for ReferenceError mentioning module", () => {
    expect(isCjsInEsmError(new ReferenceError("module is not defined"))).toBe(true);
  });

  it("returns true for ReferenceError mentioning require", () => {
    expect(isCjsInEsmError(new ReferenceError("require is not defined"))).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isCjsInEsmError(new Error("ENOENT: file not found"))).toBe(false);
    expect(isCjsInEsmError(new SyntaxError("unexpected token"))).toBe(false);
  });
});

describe("getHandlerFromModule", () => {
  it("returns function when default export is a function", () => {
    const fn = async () => {};
    const mod = { default: fn };
    expect(getHandlerFromModule(mod as Record<string, unknown>, "default")).toBe(fn);
  });

  it("returns mod when CJS module.exports = fn (mod is the function)", () => {
    const fn = async () => {};
    expect(getHandlerFromModule(fn as unknown as Record<string, unknown>, "default")).toBe(fn);
  });

  it("returns named export when exportName is not default", () => {
    const fn = async () => {};
    const mod = { myHandler: fn };
    expect(getHandlerFromModule(mod as Record<string, unknown>, "myHandler")).toBe(fn);
  });

  it("wraps object with .handle (Foundry-style) and invokes with event.context", async () => {
    const ctxLog: unknown[] = [];
    const mod = {
      default: {
        handle: (ctx: unknown) => {
          ctxLog.push(ctx);
        },
      },
    };
    const handler = getHandlerFromModule(mod as Record<string, unknown>, "default");
    expect(typeof handler).toBe("function");
    await (handler as (event: { context?: unknown }) => Promise<void>)({
      context: { tool: "read", result: "ok" },
    });
    expect(ctxLog).toEqual([{ tool: "read", result: "ok" }]);
  });

  it("wraps object with .handle and passes empty object when event.context is undefined", async () => {
    const ctxLog: unknown[] = [];
    const mod = {
      default: {
        handle: (ctx: unknown) => {
          ctxLog.push(ctx);
        },
      },
    };
    const handler = getHandlerFromModule(mod as Record<string, unknown>, "default");
    await (handler as (event: { context?: unknown }) => Promise<void>)({});
    expect(ctxLog).toEqual([{}]);
  });

  it("returns undefined when default is neither function nor object-with-handle", () => {
    const mod = { default: { foo: 1 } };
    expect(getHandlerFromModule(mod as Record<string, unknown>, "default")).toEqual({ foo: 1 });
  });
});
