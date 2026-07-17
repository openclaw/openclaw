/** Tests storage scan path discovery for non-main configured default agents. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentModelsJsonPaths, listAuthProfileStoreAgentDirs } from "./storage-scan.js";

describe("storage scan default agent paths", () => {
  let rootDir: string;
  let stateDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-storage-scan-default-"));
    stateDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(path.join(stateDir, "agents", "nova", "agent"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("uses the configured default agent dir instead of hardcoded main for auth stores", () => {
    const config = {
      agents: {
        list: [{ id: "utility" }, { id: "nova", default: true }],
      },
    } satisfies OpenClawConfig;

    expect(listAuthProfileStoreAgentDirs(config, stateDir)).toContain(
      path.join(stateDir, "agents", "nova", "agent"),
    );
    expect(listAuthProfileStoreAgentDirs(config, stateDir)).not.toContain(
      path.join(stateDir, "agents", "main", "agent"),
    );
  });

  it("uses the configured default agent dir instead of hardcoded main for models", () => {
    const config = {
      agents: {
        list: [{ id: "utility" }, { id: "nova", default: true }],
      },
    } satisfies OpenClawConfig;

    expect(listAgentModelsJsonPaths(config, stateDir, {})).toContain(
      path.join(stateDir, "agents", "nova", "agent", "models.json"),
    );
    expect(listAgentModelsJsonPaths(config, stateDir, {})).not.toContain(
      path.join(stateDir, "agents", "main", "agent", "models.json"),
    );
  });
});
