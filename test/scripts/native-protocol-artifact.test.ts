import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNativeProtocolContract } from "../../packages/gateway-protocol/scripts/native-codegen.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const root = path.resolve(import.meta.dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("native protocol build artifacts", () => {
  it("generates through a symlink, skips unchanged outputs, recovers deletion, and invalidates schema changes", () => {
    const fixture = tempDirs.make("native-protocol-source-");
    const { directories, files } = JSON.parse(
      fs.readFileSync(path.join(root, "scripts/native-protocol-inputs.json"), "utf8"),
    ) as { directories: string[]; files: string[] };
    for (const relativePath of [...directories, ...files]) {
      const destination = path.join(fixture, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.join(root, relativePath), destination, { recursive: true });
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
    const alias = path.join(tempDirs.make("native-protocol-entry-"), "source");
    fs.symlinkSync(fixture, alias, "junction");
    const generate = (check = false) =>
      execFileSync(
        process.execPath,
        [path.join(alias, "scripts/prepare-native-protocol.mjs"), ...(check ? ["--check"] : [])],
        { cwd: fixture, encoding: "utf8" },
      );
    const swiftPath = path.join(
      fixture,
      "apps/shared/OpenClawKit/.build/protocol/GatewayModels.swift",
    );
    const kotlinPath = path.join(
      fixture,
      "apps/android/gateway-client/build/generated/openclaw-protocol/ai/openclaw/app/gateway/GatewayProtocol.kt",
    );
    expect(generate(true)).toContain("contract and determinism checked");
    const swift = fs.readFileSync(swiftPath, "utf8");
    const kotlin = fs.readFileSync(kotlinPath, "utf8");
    expect(() =>
      assertNativeProtocolContract("swift", {
        "GatewayModels.swift": swift.replace(
          "public struct RequestFrame:",
          "public struct MissingFrame:",
        ),
      }),
    ).toThrow("Missing Swift model for ProtocolSchemas.RequestFrame");
    expect(() =>
      assertNativeProtocolContract("kotlin", {
        "ai/openclaw/app/gateway/GatewayProtocol.kt": kotlin.replace(
          /GATEWAY_PROTOCOL_VERSION = \d+/,
          "GATEWAY_PROTOCOL_VERSION = 999",
        ),
      }),
    ).toThrow("differs from the protocol version source");

    fs.utimesSync(swiftPath, 1, 1);
    expect(generate()).toBe("");
    expect(fs.statSync(swiftPath).mtimeMs).toBe(1000);
    fs.unlinkSync(swiftPath);
    generate();
    expect(fs.readFileSync(swiftPath, "utf8")).toBe(swift);

    const versionPath = path.join(fixture, "packages/gateway-protocol/src/version.ts");
    fs.writeFileSync(
      versionPath,
      fs
        .readFileSync(versionPath, "utf8")
        .replace(/PROTOCOL_VERSION = \d+/, "PROTOCOL_VERSION = 777"),
    );
    generate();
    expect(fs.readFileSync(swiftPath, "utf8")).toContain("GATEWAY_PROTOCOL_VERSION = 777");
    expect(fs.readFileSync(kotlinPath, "utf8")).toContain("GATEWAY_PROTOCOL_VERSION = 777");
  });
});
