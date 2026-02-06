/**
 * Trust-On-First-Use (TOFU) integrity verification for plugins.
 *
 * On first load, a plugin's manifest + tool descriptions are hashed and
 * stored as a "pin".  On subsequent loads the current manifest is compared
 * against the pin — any change in tool descriptions, added/removed tools,
 * or version bumps are flagged so the user can review before trusting the
 * updated plugin.
 *
 * Inspired by SSH host-key verification and npm lock-file integrity checks.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PluginPin = {
  pluginId: string;
  version: string;
  manifestHash: string;
  toolHashes: Record<string, string>;
  pinnedAt: number;
  lastVerified: number;
};

export type IntegrityChange =
  | { type: "version_changed"; from: string; to: string }
  | { type: "tool_added"; toolName: string }
  | { type: "tool_removed"; toolName: string }
  | { type: "tool_modified"; toolName: string };

export type IntegrityReport = {
  /** Plugin passed verification (matches pin or is newly pinned) */
  trusted: boolean;
  /** First time seeing this plugin — auto-pinned */
  firstUse: boolean;
  /** List of detected changes (empty when trusted) */
  changes: IntegrityChange[];
};

export type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type ManifestSnapshot = {
  id: string;
  version: string;
  tools: ToolDescriptor[];
};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function hashTool(tool: ToolDescriptor): string {
  const normalized = JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema != null ? JSON.stringify(tool.inputSchema) : "",
  });
  return sha256(normalized);
}

function hashManifest(manifest: ManifestSnapshot): string {
  const sortedTools = [...manifest.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema != null ? JSON.stringify(t.inputSchema) : "",
    }));
  return sha256(JSON.stringify({ id: manifest.id, version: manifest.version, tools: sortedTools }));
}

// ---------------------------------------------------------------------------
// Pin store (file-backed JSON)
// ---------------------------------------------------------------------------

export type PinStore = {
  pins: Map<string, PluginPin>;
  filePath: string;
};

export function createPinStore(filePath: string): PinStore {
  const pins = new Map<string, PluginPin>();

  // Load existing pins if file exists
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, PluginPin>;
      for (const [id, pin] of Object.entries(raw)) {
        pins.set(id, pin);
      }
    } catch {
      // Corrupted pin file — start fresh
    }
  }

  return { pins, filePath };
}

export function savePinStore(store: PinStore): void {
  const dir = path.dirname(store.filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data: Record<string, PluginPin> = {};
  for (const [id, pin] of store.pins) {
    data[id] = pin;
  }
  fs.writeFileSync(store.filePath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Pin a plugin manifest.  Called on first use or after user approval.
 */
export function pinPlugin(store: PinStore, manifest: ManifestSnapshot): PluginPin {
  const toolHashes: Record<string, string> = {};
  for (const tool of manifest.tools) {
    toolHashes[tool.name] = hashTool(tool);
  }
  const pin: PluginPin = {
    pluginId: manifest.id,
    version: manifest.version,
    manifestHash: hashManifest(manifest),
    toolHashes,
    pinnedAt: Date.now(),
    lastVerified: Date.now(),
  };
  store.pins.set(manifest.id, pin);
  return pin;
}

/**
 * Verify a plugin manifest against its stored pin.
 *
 * - First use → auto-pin, returns trusted + firstUse
 * - Unchanged → returns trusted
 * - Changed → returns untrusted + list of changes
 */
export function verifyPlugin(store: PinStore, manifest: ManifestSnapshot): IntegrityReport {
  const pin = store.pins.get(manifest.id);

  // First use — pin and trust
  if (!pin) {
    pinPlugin(store, manifest);
    return { trusted: true, firstUse: true, changes: [] };
  }

  // Quick check — if overall hash matches, nothing changed
  const currentHash = hashManifest(manifest);
  if (currentHash === pin.manifestHash) {
    pin.lastVerified = Date.now();
    return { trusted: true, firstUse: false, changes: [] };
  }

  // Something changed — figure out what
  const changes: IntegrityChange[] = [];

  // Version
  if (manifest.version !== pin.version) {
    changes.push({ type: "version_changed", from: pin.version, to: manifest.version });
  }

  // Tools diff
  const currentToolNames = new Set(manifest.tools.map((t) => t.name));
  const pinnedToolNames = new Set(Object.keys(pin.toolHashes));

  for (const name of currentToolNames) {
    if (!pinnedToolNames.has(name)) {
      changes.push({ type: "tool_added", toolName: name });
    }
  }

  for (const name of pinnedToolNames) {
    if (!currentToolNames.has(name)) {
      changes.push({ type: "tool_removed", toolName: name });
    }
  }

  for (const tool of manifest.tools) {
    if (pinnedToolNames.has(tool.name)) {
      const currentToolHash = hashTool(tool);
      if (currentToolHash !== pin.toolHashes[tool.name]) {
        changes.push({ type: "tool_modified", toolName: tool.name });
      }
    }
  }

  return { trusted: false, firstUse: false, changes };
}

/**
 * Re-pin a plugin after user has reviewed changes.
 * Equivalent to "I trust this new version."
 */
export function approvePlugin(store: PinStore, manifest: ManifestSnapshot): PluginPin {
  return pinPlugin(store, manifest);
}

/**
 * Remove a pin (e.g. when uninstalling a plugin).
 */
export function unpinPlugin(store: PinStore, pluginId: string): boolean {
  return store.pins.delete(pluginId);
}

/**
 * Get the pin for a specific plugin, or undefined.
 */
export function getPin(store: PinStore, pluginId: string): PluginPin | undefined {
  return store.pins.get(pluginId);
}
