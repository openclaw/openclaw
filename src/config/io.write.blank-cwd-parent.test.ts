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

  it("a full write without explicit path metadata rejects a newly supplied blank cwd", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151091-nopaths-"));
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
      // The public writer contract allows omitting explicitSetPaths; a blank
      // supplied in that full-config write must still be rejected, not
      // silently migrated away by the write migration.
      await writeConfigFileFromContext(ctx, next, {}, async () => base);
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain("cwd");
    expect(message).toContain("blank");
  });

  it("a full write without explicit path metadata migrates a saved blank cwd instead of rejecting it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151091-saved-nopaths-"));
    // The saved config carries a historically accepted blank cwd.
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { alpha: { cwd: " " } } },
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
    expect(persisted).not.toContain('"cwd"');
  });

  it("a saved blank cwd re-authored via an explicit whole-list replacement is rejected (preserved)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151091-saved-wholelist-"));
    // The saved config carries a historically accepted blank cwd in the legacy
    // list form.
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "alpha", model: "openai/gpt-5.6", cwd: " " }] },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config));
    // Replacing the whole legacy list and re-authoring the blank is explicit
    // authoring: the field error must surface, so the whole-list explicit path
    // is remapped to the entries form and the migration preserves the blank.
    next.agents = { list: [{ id: "alpha", model: "openai/gpt-5.6", cwd: " " }] };
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
    expect(message).toContain("cwd");
    expect(message).toContain("blank");
  });
});
