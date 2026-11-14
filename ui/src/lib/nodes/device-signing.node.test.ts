import { webcrypto } from "node:crypto";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyEd25519SignatureBytes } from "../../../../src/infra/ed25519-signature.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../../test-helpers/playwright-chromium.ts";

// RFC 8032 section 7.1: independent seed, public-key and signature fixtures.
const fixtures = [
  {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    signature:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f" +
      "b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "72",
    signature:
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da" +
      "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    publicKey: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    message: "af82",
    signature:
      "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac" +
      "18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
];

function verifies(signature: Uint8Array, message: Uint8Array, publicKeyHex: string): boolean {
  return verifyEd25519SignatureBytes({
    publicKey: Buffer.from(publicKeyHex, "hex").toString("base64url"),
    payload: Buffer.from(message),
    signatureBase64Url: Buffer.from(signature).toString("base64url"),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("device Ed25519 signing", () => {
  it.each(fixtures)(
    "preserves RFC public identity and deterministic fallback for seed $seed",
    async (fixture) => {
      const { getPublicKeyAsync, signAsync } = await import("./device-signing.runtime.ts");
      const seed = Uint8Array.fromHex(fixture.seed);
      const message = Uint8Array.fromHex(fixture.message);
      const publicKey = await getPublicKeyAsync(seed);
      expect(publicKey.toHex()).toBe(fixture.publicKey);
      const signature = await signAsync(message, seed);
      expect(verifies(signature, message, fixture.publicKey)).toBe(true);

      vi.stubGlobal("crypto", undefined);
      expect((await signAsync(message, seed)).toHex()).toBe(fixture.signature);
      expect(await getPublicKeyAsync(seed)).toEqual(publicKey);
    },
  );

  it("reuses a non-extractable import without mixing interleaved identities", async () => {
    const { signAsync } = await import("./device-signing.runtime.ts");
    const imports = vi.spyOn(crypto.subtle, "importKey");
    const signs = vi.spyOn(crypto.subtle, "sign");
    const first = Uint8Array.fromHex(fixtures[0]!.seed);
    const second = Uint8Array.fromHex(fixtures[1]!.seed);
    const message = new TextEncoder().encode("connect|synthetic-identity|🦞");
    const signatures = await Promise.all([
      signAsync(message, first),
      signAsync(message, first),
      signAsync(message, second),
    ]);
    expect(imports).toHaveBeenCalledTimes(2);
    signatures.push(await signAsync(message, first));
    for (const [i, signature] of signatures.entries()) {
      expect(verifies(signature, message, fixtures[i === 2 ? 1 : 0]!.publicKey)).toBe(true);
    }
    expect(imports).toHaveBeenCalledTimes(3);
    const key = signs.mock.calls[0]?.[1];
    if (!key) {
      throw new Error("native signing did not receive a key");
    }
    expect(key.extractable).toBe(false);
    expect(key.type).toBe("private");
    expect(key.usages).toEqual(["sign"]);
    await expect(crypto.subtle.exportKey("pkcs8", key)).rejects.toThrow();
  });

  it("falls back when Ed25519 is unsupported without retrying the import", async () => {
    const { signAsync } = await import("./device-signing.runtime.ts");
    const imports = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValue(new DOMException("Ed25519 unavailable", "NotSupportedError"));
    const seed = Uint8Array.fromHex(fixtures[0]!.seed);
    const message = new Uint8Array();
    expect((await signAsync(message, seed)).toHex()).toBe(fixtures[0]!.signature);
    expect((await signAsync(message, seed)).toHex()).toBe(fixtures[0]!.signature);
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it.each(["importKey", "sign"] as const)("falls back after native %s fails", async (operation) => {
    const { signAsync } = await import("./device-signing.runtime.ts");
    vi.spyOn(crypto.subtle, operation).mockRejectedValue(
      new DOMException("native failed", "OperationError"),
    );
    const seed = Uint8Array.fromHex(fixtures[0]!.seed);
    const message = new Uint8Array();
    expect((await signAsync(message, seed)).toHex()).toBe(fixtures[0]!.signature);
    await expect(signAsync(message, new Uint8Array(31))).rejects.toThrow();
  });

  it.each(["chromium", "webkit", "firefox"] as const)(
    "preserves RFC public identity and valid native signatures in %s",
    async (engine) => {
      const bundled = await build({
        entryPoints: [new URL("./device-signing.runtime.ts", import.meta.url).pathname],
        bundle: true,
        write: false,
        format: "iife",
        globalName: "deviceSigning",
      });
      const browser = await { chromium, webkit, firefox }[engine].launch({
        headless: true,
        ...(engine === "chromium"
          ? { executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()) }
          : {}),
      });
      try {
        const page = await browser.newPage();
        await page.route("http://127.0.0.1/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Synthetic Ed25519 proof</title>",
          }),
        );
        await page.goto("http://127.0.0.1/");
        await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
        const results = await page.evaluate(async (values) => {
          const signer: typeof import("./device-signing.runtime.ts") = Reflect.get(
            window,
            "deviceSigning",
          );
          if (!crypto.subtle) {
            throw new Error("Native crypto unavailable on secure fixture origin");
          }
          const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
          let nativeSigns = 0;
          crypto.subtle.sign = (...args) => {
            nativeSigns++;
            return nativeSign(...args);
          };
          const output = [];
          for (const fixture of values) {
            const seed = Uint8Array.fromHex(fixture.seed);
            const message = Uint8Array.fromHex(fixture.message);
            output.push({
              publicKey: (await signer.getPublicKeyAsync(seed)).toHex(),
              signature: (await signer.signAsync(message, seed)).toHex(),
            });
          }
          if (nativeSigns !== values.length) {
            throw new Error("Fixtures did not exercise native Ed25519");
          }
          Object.defineProperty(window, "crypto", { configurable: true, value: undefined });
          for (const fixture of values) {
            const seed = Uint8Array.fromHex(fixture.seed);
            output.push({
              publicKey: (await signer.getPublicKeyAsync(seed)).toHex(),
              signature: (
                await signer.signAsync(Uint8Array.fromHex(fixture.message), seed)
              ).toHex(),
            });
          }
          return output;
        }, fixtures);
        const expected = fixtures.map(({ publicKey, signature }) => ({ publicKey, signature }));
        expect(results.slice(fixtures.length)).toEqual(expected);
        for (const [i, result] of results.slice(0, fixtures.length).entries()) {
          const fixture = fixtures[i]!;
          expect(result.publicKey).toBe(fixture.publicKey);
          expect(
            verifies(
              Uint8Array.fromHex(result.signature),
              Uint8Array.fromHex(fixture.message),
              result.publicKey,
            ),
          ).toBe(true);
        }
      } finally {
        await browser.close();
      }
    },
    30000,
  );
});
