import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as providerAuthRuntime from "./provider-auth-runtime.js";

describe("plugin-sdk provider-auth-runtime", () => {
  it("exports the runtime-ready auth helper", () => {
    expect(providerAuthRuntime.getRuntimeAuthForModel).toBeTypeOf("function");
  });

  it("generates random OAuth state tokens", () => {
    const first = providerAuthRuntime.generateOAuthState();
    const second = providerAuthRuntime.generateOAuthState();

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("parses OAuth callback URLs and rejects bare codes", () => {
    expect(
      providerAuthRuntime.parseOAuthCallbackInput(
        "http://127.0.0.1:3000/callback?code=abc&state=state-1",
      ),
    ).toEqual({ code: "abc", state: "state-1" });
    expect(providerAuthRuntime.parseOAuthCallbackInput("abc")).toEqual({
      error: "Paste the full redirect URL, not just the code.",
    });
  });

  it("resolves hashed runtime auth chunks when the stable alias is absent", () => {
    const baseDir = "/virtual/plugin-sdk";
    const hashedFile = "runtime-model-auth.runtime-Hash123.js";

    const href = providerAuthRuntime.__testOnly.resolveRuntimeModelAuthModuleHrefFrom(baseDir, {
      existsSync: (value) => value === baseDir,
      statSync: ((value: string) => ({
        isDirectory: () => value === baseDir,
      })) as typeof fs.statSync,
      readdirSync: ((value: string) =>
        value === baseDir ? [hashedFile] : []) as typeof fs.readdirSync,
      dirname: path.dirname,
      basename: path.basename,
      resolve: path.resolve,
      join: path.join,
      pathToFileURL,
    });

    expect(href).toBe(`file://${baseDir}/${hashedFile}`);
  });
});
