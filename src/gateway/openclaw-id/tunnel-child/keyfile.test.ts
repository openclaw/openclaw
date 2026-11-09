import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyFileRefusedError, loadOrCreateEndpointKey } from "./keyfile.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function keyPath() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-id-key-"));
  return path.join(dir, "iroh", "endpoint.key");
}

describe("tunnel endpoint key file", () => {
  it("creates a 0600 key once and loads the same key afterwards", () => {
    const file = keyPath();
    const created = loadOrCreateEndpointKey(file);
    expect(created.created).toBe(true);
    expect(created.key).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const loaded = loadOrCreateEndpointKey(file);
    expect(loaded).toEqual({ key: created.key, created: false });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a group-readable key instead of replacing it",
    () => {
      const file = keyPath();
      loadOrCreateEndpointKey(file);
      fs.chmodSync(file, 0o640);
      expect(() => loadOrCreateEndpointKey(file)).toThrow(KeyFileRefusedError);
      expect(fs.readFileSync(file)).toHaveLength(32);
    },
  );

  it("refuses a corrupt key", () => {
    const file = keyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "short", { mode: 0o600 });
    expect(() => loadOrCreateEndpointKey(file)).toThrow(KeyFileRefusedError);
  });
});
