import { describe, expect, it, vi, beforeEach } from "vitest";

// Each test re-imports `./qr-runtime.ts` after wiring fresh mocks, since the
// loader caches the resolved runtime in module state. `vi.resetModules()`
// resets that module state and the per-test `vi.doMock` calls install fresh
// mock factories for the next dynamic `import("qrcode")` resolution.

const fakeRuntime = {
  toString: vi.fn(async () => "ASCII-QR"),
};

beforeEach(() => {
  vi.resetModules();
});

describe("loadQrCodeRuntime", () => {
  it("uses the bare `qrcode` import when it resolves cleanly (canonical dev path)", async () => {
    vi.doMock("qrcode", () => ({ default: fakeRuntime }));

    const { loadQrCodeRuntime } = await import("./qr-runtime.ts");
    const runtime = await loadQrCodeRuntime();

    expect(runtime).toBe(fakeRuntime);
  });

  // Regression for #75394: staged plugin-runtime-deps trees can ship qrcode
  // without an addressable `package.json`, so the bare specifier fails with
  // `Cannot find package 'qrcode'` even though `qrcode/lib/index.js` is on
  // disk. The loader must fall back to the explicit lib entry rather than
  // surfacing the failure to WhatsApp/Feishu QR rendering.
  it("falls back to `qrcode/lib/index.js` when bare `qrcode` fails to resolve", async () => {
    vi.doMock("qrcode", () => {
      throw new Error("Cannot find package 'qrcode' imported from /staged/dist/qr-terminal.js");
    });
    vi.doMock("qrcode/lib/index.js", () => ({ default: fakeRuntime }));

    const { loadQrCodeRuntime } = await import("./qr-runtime.ts");
    const runtime = await loadQrCodeRuntime();

    expect(runtime).toBe(fakeRuntime);
  });

  it("rejects when both bare and lib-fallback imports fail to resolve", async () => {
    vi.doMock("qrcode", () => {
      throw new Error("Cannot find package 'qrcode'");
    });
    vi.doMock("qrcode/lib/index.js", () => {
      throw new Error("missing lib entry");
    });

    const { loadQrCodeRuntime } = await import("./qr-runtime.ts");
    // The exact message comes from vitest's mock-factory error wrapper, but
    // the contract we want to verify is just that the loader rejects rather
    // than silently returning a broken runtime when both paths fail.
    await expect(loadQrCodeRuntime()).rejects.toThrow();
  });

  it("caches the resolved runtime across repeated calls within the same module load", async () => {
    let bareCalls = 0;
    vi.doMock("qrcode", () => {
      bareCalls += 1;
      return { default: fakeRuntime };
    });

    const { loadQrCodeRuntime } = await import("./qr-runtime.ts");
    await loadQrCodeRuntime();
    await loadQrCodeRuntime();
    await loadQrCodeRuntime();

    // The first call dispatches the dynamic import factory once; subsequent
    // calls hit the cached promise without re-running it.
    expect(bareCalls).toBe(1);
  });

  it("uses the lib-entry module's default export when bare import fails", async () => {
    // CommonJS-style modules expose their public surface on `default` under
    // ESM interop; verify the loader unwraps that on the fallback path too.
    vi.doMock("qrcode", () => {
      throw new Error("bare specifier missing");
    });
    vi.doMock("qrcode/lib/index.js", () => ({ default: fakeRuntime }));

    const { loadQrCodeRuntime } = await import("./qr-runtime.ts");
    const runtime = await loadQrCodeRuntime();

    expect(runtime).toBe(fakeRuntime);
  });
});
