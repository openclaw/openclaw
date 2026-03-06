import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDiscordComponentEntries,
  loadComponentRegistry,
  registerDiscordComponentEntries,
  resolveDiscordComponentEntry,
  resolveDiscordModalEntry,
  setComponentRegistryStorePath,
} from "./components-registry.js";

describe("discord component registry — persistence across restart", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(os.tmpdir(), `occomp-test-${Date.now()}.json`);
    clearDiscordComponentEntries();
  });

  afterEach(() => {
    // Clean up temp file
    try {
      fs.unlinkSync(storePath);
    } catch {
      // ignore
    }
    // Reset store path so other tests are unaffected
    setComponentRegistryStorePath(null);
    clearDiscordComponentEntries();
  });

  it("entries survive simulated gateway restart when store path is configured", () => {
    // Configure persistence
    setComponentRegistryStorePath(storePath);

    // Register entries (should be written to disk)
    registerDiscordComponentEntries({
      entries: [{ id: "btn_persist_1", kind: "button", label: "Click me" }],
      modals: [
        {
          id: "mdl_persist_1",
          title: "Confirm",
          fields: [{ id: "fld_1", name: "reason", label: "Reason", type: "text" }],
        },
      ],
      messageId: "msg_persist_1",
      ttlMs: 60 * 60 * 1000, // 1 hour — should not expire
    });

    // Verify disk file was written
    expect(fs.existsSync(storePath)).toBe(true);

    // Simulate gateway restart: detach store path so flush is a no-op (matching
    // real restart behaviour where the in-process module is re-initialised from
    // scratch), then wipe in-memory Maps.
    setComponentRegistryStorePath(null);
    clearDiscordComponentEntries();

    // After restart, entries should be gone from memory
    expect(resolveDiscordComponentEntry({ id: "btn_persist_1", consume: false })).toBeNull();
    expect(resolveDiscordModalEntry({ id: "mdl_persist_1", consume: false })).toBeNull();

    // Reload from disk (what gateway startup should call)
    loadComponentRegistry(storePath);

    // Entries should be restored
    const entry = resolveDiscordComponentEntry({ id: "btn_persist_1", consume: false });
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("btn_persist_1");
    expect(entry?.messageId).toBe("msg_persist_1");

    const modal = resolveDiscordModalEntry({ id: "mdl_persist_1", consume: false });
    expect(modal).not.toBeNull();
    expect(modal?.id).toBe("mdl_persist_1");
    expect(modal?.title).toBe("Confirm");
  });

  it("clearDiscordComponentEntries flushes empty state to disk so cleared entries do not reappear after restart", () => {
    setComponentRegistryStorePath(storePath);

    // Register an entry so the disk file is populated
    registerDiscordComponentEntries({
      entries: [{ id: "btn_clear_test", kind: "button", label: "Temp" }],
      modals: [],
      messageId: "msg_clear_test",
      ttlMs: 60 * 60 * 1000,
    });
    expect(fs.existsSync(storePath)).toBe(true);

    // Clear — should overwrite disk with empty state
    clearDiscordComponentEntries();

    // Disk file should exist but contain empty arrays
    const diskData = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      componentEntries: unknown[];
      modalEntries: unknown[];
    };
    expect(diskData.componentEntries).toHaveLength(0);
    expect(diskData.modalEntries).toHaveLength(0);

    // Simulated restart: loading from the flushed file should restore nothing
    loadComponentRegistry(storePath);
    expect(resolveDiscordComponentEntry({ id: "btn_clear_test", consume: false })).toBeNull();
  });

  it("loadComponentRegistry evicts expired entries on load", () => {
    // Write test data directly — do NOT configure the store path yet so that
    // clearDiscordComponentEntries() below is a memory-only reset (no disk flush).
    const now = Date.now();
    const diskData = {
      componentEntries: [
        {
          id: "btn_expired",
          kind: "button",
          label: "Old",
          createdAt: now - 2 * 60 * 60 * 1000, // 2h ago
          expiresAt: now - 60 * 1000, // expired 60s ago
        },
        {
          id: "btn_valid",
          kind: "button",
          label: "New",
          createdAt: now - 5 * 60 * 1000,
          expiresAt: now + 25 * 60 * 1000, // expires in 25m
        },
      ],
      modalEntries: [],
    };
    fs.writeFileSync(storePath, JSON.stringify(diskData), "utf8");

    clearDiscordComponentEntries();
    loadComponentRegistry(storePath);

    // Expired entry should not be loaded
    expect(resolveDiscordComponentEntry({ id: "btn_expired", consume: false })).toBeNull();
    // Valid entry should be present
    expect(resolveDiscordComponentEntry({ id: "btn_valid", consume: false })).not.toBeNull();
  });
});
