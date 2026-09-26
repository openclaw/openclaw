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

describe("saved blank agent workspace does not block unrelated config writes", () => {
  it("an unrelated gateway.port write persists despite the saved blank workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-150929-write-"));
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { alpha: { workspace: "   " } } },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config)) as {
      gateway?: { port?: number };
    };
    if (next.gateway) next.gateway.port = 18888;
    const result = await writeConfigFileFromContext(
      ctx,
      next as never,
      { explicitSetPaths: [["gateway", "port"]] },
      async () => base,
    );
    expect(result).toBeDefined();
    const persisted = JSON.parse(fs.readFileSync(path.join(root, "openclaw.json"), "utf-8"));
    expect(persisted.gateway.port).toBe(18888);
    // The saved blank workspace was migrated on write, not preserved as invalid.
    if (persisted.agents?.entries?.alpha?.workspace !== undefined) {
      expect(persisted.agents.entries.alpha.workspace.trim()).not.toBe("");
    }
  });
});

describe("newly authored blank agent workspace is still rejected", () => {
  it("setting a blank workspace explicitly is rejected, not silently migrated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-150929-write-new-"));
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { alpha: {} } },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config)) as {
      agents: { entries: Record<string, { workspace?: string }> };
    };
    next.agents.entries.alpha.workspace = " ";
    let threw = false;
    let message = "";
    try {
      await writeConfigFileFromContext(
        ctx,
        next,
        { explicitSetPaths: [["agents", "entries", "alpha", "workspace"]] },
        async () => base,
      );
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("workspace");
  });

  it("setting a blank workspace through the legacy agents.list path is rejected, not migrated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-150929-write-list-"));
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "alpha" }] },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config)) as {
      agents: { list: Array<{ id: string; workspace?: string }> };
    };
    // Canonical roster preparation converts the explicit list edit into
    // agents.entries.alpha; the blank must still be rejected, not discarded.
    next.agents.list = [{ id: "alpha", workspace: " " }];
    let threw = false;
    let message = "";
    try {
      await writeConfigFileFromContext(
        ctx,
        next,
        { explicitSetPaths: [["agents", "list", "0", "workspace"]] },
        async () => base,
      );
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("workspace");
    expect(message).toContain("blank");
  });

  it("a full write without explicit path metadata rejects a newly supplied blank workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-150929-write-nopaths-"));
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { alpha: {} } },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config)) as {
      agents: { entries: Record<string, { workspace?: string }> };
    };
    next.agents.entries.alpha.workspace = " ";
    let threw = false;
    let message = "";
    try {
      // The public writer contract allows omitting explicitSetPaths; a blank
      // supplied in that full-config write must still be rejected, not
      // silently migrated away by the write migration.
      await writeConfigFileFromContext(ctx, next, {}, async () => base);
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("workspace");
    expect(message).toContain("blank");
  });

  it("a full write without explicit path metadata migrates a saved blank workspace instead of rejecting it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-150929-write-saved-nopaths-"));
    // The saved config carries a historically accepted blank workspace.
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { alpha: { workspace: " " } } },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config)) as {
      agents: { entries: Record<string, { workspace?: string }> };
      gateway: { port?: number };
    };
    // An unrelated full-config write (no explicitSetPaths) must not be blocked
    // by the restored saved blank: the migration sees it is saved (present in
    // the pre-write source) and removes it, so the write succeeds.
    next.gateway.port = 18800;
    let threw = false;
    try {
      await writeConfigFileFromContext(ctx, next, {}, async () => base);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    const persisted = fs.readFileSync(path.join(root, "openclaw.json"), "utf-8");
    expect(persisted).not.toContain('"workspace"');
  });
});
