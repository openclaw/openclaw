import { describe, expect, it, vi } from "vitest";
import { createNonExitingRuntime, safeJsonOutput, writeRuntimeJson } from "./runtime.js";
import type { RuntimeEnv } from "./runtime.js";

function circularValue() {
  const obj: Record<string, unknown> = {};
  obj.self = obj;
  return obj;
}

function nullProtoCircular() {
  const obj = Object.create(null);
  obj.self = obj;
  return obj;
}

describe("safeJsonOutput", () => {
  it("serializes plain objects with default spacing", () => {
    expect(safeJsonOutput({ ok: true }, 2)).toBe('{\n  "ok": true\n}');
  });

  it("serializes compact without space", () => {
    expect(safeJsonOutput({ ok: true })).toBe('{"ok":true}');
  });

  it("serializes with custom space", () => {
    expect(safeJsonOutput({ a: 1 }, 0)).toBe('{"a":1}');
  });

  it("falls back to String(value) for circular references", () => {
    expect(safeJsonOutput(circularValue())).toBe('"[object Object]"');
  });

  it("falls back to constant for null-prototype circular references", () => {
    expect(safeJsonOutput(nullProtoCircular())).toBe('"[unserializable]"');
  });
});

describe("writeRuntimeJson", () => {
  it("serializes plain objects via writeJson", () => {
    const runtime = createNonExitingRuntime();
    const spy = vi.spyOn(runtime, "writeJson");
    writeRuntimeJson(runtime, { ok: true });
    expect(spy).toHaveBeenCalledWith({ ok: true }, 2);
  });

  it("handles circular references via writeJson", () => {
    const runtime = createNonExitingRuntime();
    const spy = vi.spyOn(runtime, "writeJson");
    writeRuntimeJson(runtime, circularValue());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("handles null-prototype circular references via writeJson", () => {
    const runtime = createNonExitingRuntime();
    const spy = vi.spyOn(runtime, "writeJson");
    writeRuntimeJson(runtime, nullProtoCircular());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("delegates to runtime.log when writeStdout is absent", () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    writeRuntimeJson(runtime, { key: 1 });
    expect(runtime.log).toHaveBeenCalledWith('{\n  "key": 1\n}');
  });

  it("falls back to String(value) in log path for circular references", () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    writeRuntimeJson(runtime, circularValue());
    expect(runtime.log).toHaveBeenCalledWith('"[object Object]"');
  });

  it("falls back to constant in log path for null-prototype circular references", () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    writeRuntimeJson(runtime, nullProtoCircular());
    expect(runtime.log).toHaveBeenCalledWith('"[unserializable]"');
  });
});
