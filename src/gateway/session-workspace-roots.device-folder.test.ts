import { describe, expect, it } from "vitest";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

describe("device-folder workspace roots", () => {
  it.each([{}, { spawnedCwd: "/gateway/workspace", spawnedWorkspaceDir: "/gateway/workspace" }])(
    "never projects remote paths or stale local metadata as Gateway roots: %j",
    (metadata) => {
      expect(
        resolveSessionWorkspaceRoots(
          {},
          "main",
          {
            ...metadata,
            deviceFolder: { deviceId: "paired-device", path: "/remote/folder" },
          },
          { sessionKey: "agent:main:main", fileToolsOnGatewayHost: true },
        ),
      ).toMatchObject({
        readScope: "root",
        root: undefined,
        spawnedCwd: undefined,
        diffCwd: undefined,
      });
    },
  );
});
