import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIoContext } from "./io.context.js";
import { readConfigFileSnapshotInternal } from "./io.snapshot.js";
import { writeConfigFileFromContext } from "./io.write.js";

function makeContext(root: string) {
  const configPath = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    VITEST: "true",
  };
  return createConfigIoContext({ configPath, env, homedir: () => root, observe: false });
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

describe("parent-object blank cwd authoring is still rejected", () => {
  it("setting agents.entries.alpha (object with blank cwd) is rejected, not silently migrated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151091-par-"));
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { alpha: {} } },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config));
    next.agents.entries.alpha = { cwd: " " };
    let threw = false;
    let message = "";
    try {
      await writeConfigFileFromContext(
        ctx,
        next,
        { explicitSetPaths: [["agents", "entries", "alpha"]] },
        async () => base,
      );
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    // A parent-path explicitSet (object edit) must still surface the blank error.
    expect(threw).toBe(true);
    expect(message).toContain("cwd");
  });

  it("setting a blank cwd through the legacy agents.list path is rejected, not migrated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151091-list-"));
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "alpha" }] },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config));
    // Canonical roster preparation converts the explicit list edit into
    // agents.entries.alpha; the blank must still be rejected, not discarded.
    next.agents.list = [{ id: "alpha", cwd: " " }];
    let threw = false;
    let message = "";
    try {
      await writeConfigFileFromContext(
        ctx,
        next,
        { explicitSetPaths: [["agents", "list", "0", "cwd"]] },
        async () => base,
      );
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("cwd");
    expect(message).toContain("blank");
  });
});
