import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";

export const nodeUpdateMetadata = {
  name: "openclaw",
  version: "2026.9.18",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  packageOpenClaw: {
    schemaVersions: { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
  },
};

export async function writeNodeUpdateCandidate(
  root: string,
  version = nodeUpdateMetadata.version,
): Promise<void> {
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version, openclaw: nodeUpdateMetadata.packageOpenClaw }),
  );
  await Promise.all(
    [
      "openclaw.mjs",
      "node-host-launcher.mjs",
      "dist/node-host-launcher-bootstrap.js",
      "dist/entry.js",
    ].map((file) => fs.writeFile(path.join(root, file), "export {};\n")),
  );
}

export function useNodeUpdateRuntime(runtime?: "bun" | "node", platform?: NodeJS.Platform) {
  const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalVersions = Object.getOwnPropertyDescriptor(process, "versions")!;
  const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const select = (selected: "bun" | "node", selectedPlatform = platform) => {
    if (selected === "bun") {
      Object.defineProperty(process.versions, "bun", { value: "1.4.3", configurable: true });
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
    if (selectedPlatform) {
      Object.defineProperty(process, "platform", { value: selectedPlatform, configurable: true });
    }
  };
  if (runtime) {
    beforeEach(() => select(runtime));
  }
  afterEach(() => {
    Object.defineProperty(process, "versions", originalVersions);
    Object.defineProperty(process, "execPath", originalExecPath);
    if (bun) {
      Object.defineProperty(process.versions, "bun", bun);
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
    Object.defineProperty(process, "platform", originalPlatform);
  });
  return select;
}
