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

describe("parent-object blank agentDir authoring is still rejected", () => {
  it("setting agents.entries.alpha (object with blank agentDir) is rejected, not silently migrated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151013-par-"));
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
    next.agents.entries.alpha = { agentDir: " " };
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
    expect(threw).toBe(true);
    expect(message).toContain("agentDir");
  });

  it("setting a blank agentDir through the legacy agents.list path is rejected, not migrated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151013-list-"));
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
    next.agents.list = [{ id: "alpha", agentDir: " " }];
    let threw = false;
    let message = "";
    try {
      await writeConfigFileFromContext(
        ctx,
        next,
        { explicitSetPaths: [["agents", "list", "0", "agentDir"]] },
        async () => base,
      );
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("agentDir");
    expect(message).toContain("blank");
  });

  it("a full write without explicit path metadata rejects a newly supplied blank agentDir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151013-nopaths-"));
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
    next.agents.entries.alpha = { agentDir: " " };
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
    expect(message).toContain("agentDir");
    expect(message).toContain("blank");
  });

  it("a full write without explicit path metadata migrates a saved blank agentDir instead of rejecting it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151013-saved-nopaths-"));
    // The saved config carries a historically accepted blank agentDir.
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { alpha: { agentDir: " " } } },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config));
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
    expect(persisted).not.toContain('"agentDir"');
  });

  it("a saved blank agentDir re-authored via an explicit whole-list replacement is rejected (preserved)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151013-saved-wholelist-"));
    // The saved config carries a historically accepted blank agentDir in the
    // legacy list form.
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "alpha", model: "openai/gpt-5.6", agentDir: " " }] },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config));
    // The operator replaces the whole legacy list and re-authors the blank
    // agentDir. That is explicit authoring, so the field error must surface —
    // the whole-list explicit path must be remapped to the entries form so the
    // write migration preserves the re-authored blank instead of migrating the
    // saved one.
    next.agents = { list: [{ id: "alpha", model: "openai/gpt-5.6", agentDir: " " }] };
    let threw = false;
    let message = "";
    try {
      await writeConfigFileFromContext(
        ctx,
        next,
        { explicitSetPaths: [["agents", "list"]] },
        async () => base,
      );
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("agentDir");
    expect(message).toContain("blank");
  });
});
