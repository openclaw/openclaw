import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readBackgroundScript(): string {
  const scriptPath = resolve(process.cwd(), "assets/chrome-extension/background.js");
  return readFileSync(scriptPath, "utf8");
}

describe("chrome extension handshake payload", () => {
  it("uses a gateway-recognized client id", () => {
    const source = readBackgroundScript();
    expect(source).toContain("id: 'webchat-ui'");
    expect(source).not.toContain("id: 'chrome-relay-extension'");
  });

  it("does not send unsupported top-level nonce in connect params", () => {
    const source = readBackgroundScript();
    expect(source).not.toMatch(/^\s*nonce:\s*nonce\s*\|\|\s*undefined\s*,?\s*$/m);
  });
});
