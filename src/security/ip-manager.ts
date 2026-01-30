/**
 * IP blocklist and allowlist management
 * File-based storage with auto-expiration
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { securityLogger } from "./events/logger.js";
import { SecurityActions } from "./events/schema.js";
import { getFirewallManager } from "./firewall/manager.js";

const BLOCKLIST_FILE = "blocklist.json";
const SECURITY_DIR_NAME = "security";

export interface BlocklistEntry {
  ip: string;
  reason: string;
  blockedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
  source: "auto" | "manual";
  eventId?: string;
}

export interface AllowlistEntry {
  ip: string;
  reason: string;
  addedAt: string; // ISO 8601
  source: "auto" | "manual";
}

export interface IpListStore {
  version: number;
  blocklist: BlocklistEntry[];
  allowlist: AllowlistEntry[];
}

/**
 * Get security directory path
 */
function getSecurityDir(stateDir?: string): string {
  const base = stateDir ?? path.join(os.homedir(), ".openclaw");
  return path.join(base, SECURITY_DIR_NAME);
}

/**
 * Get blocklist file path
 */
function getBlocklistPath(stateDir?: string): string {
  return path.join(getSecurityDir(stateDir), BLOCKLIST_FILE);
}

/**
 * Load IP list store from disk
 */
function loadStore(stateDir?: string): IpListStore {
  const filePath = getBlocklistPath(stateDir);

  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      blocklist: [],
      allowlist: [],
    };
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content) as IpListStore;
  } catch {
    // If file is corrupted, start fresh
    return {
      version: 1,
      blocklist: [],
      allowlist: [],
    };
  }
}

/**
 * Save IP list store to disk
 */
function saveStore(store: IpListStore, stateDir?: string): void {
  const filePath = getBlocklistPath(stateDir);
  const dir = path.dirname(filePath);

  // Ensure directory exists with proper permissions
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Write with proper permissions
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Check if an IP matches a CIDR block
 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  // Simple exact match for non-CIDR entries
  if (!cidr.includes("/")) {
    return ip === cidr;
  }

  // Parse CIDR notation
  const [network, bits] = cidr.split("/");
  const maskBits = parseInt(bits, 10);

  if (isNaN(maskBits)) return false;

  // Convert IPs to numbers for comparison
  const ipNum = ipToNumber(ip);
  const networkNum = ipToNumber(network);

  if (ipNum === null || networkNum === null) return false;

  // Calculate mask
  const mask = -1 << (32 - maskBits);

  // Check if IP is in network
  return (ipNum & mask) === (networkNum & mask);
}

/**
 * Convert IPv4 address to number
 */
function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let num = 0;
  for (const part of parts) {
    const val = parseInt(part, 10);
    if (isNaN(val) || val < 0 || val > 255) return null;
    num = num * 256 + val;
  }

  return num;
}

/**
 * IP manager for blocklist and allowlist
 */
export class IpManager {
  private store: IpListStore;
  private stateDir?: string;

  constructor(params?: { stateDir?: string }) {
    this.stateDir = params?.stateDir;
    this.store = loadStore(this.stateDir);

    // Clean up expired entries on load
    this.cleanupExpired();
  }

  /**
   * Check if an IP is blocked
   * Returns block reason if blocked, null otherwise
   */
  isBlocked(ip: string): string | null {
    // Allowlist overrides blocklist
    if (this.isAllowed(ip)) {
      return null;
    }

    const now = new Date().toISOString();

    for (const entry of this.store.blocklist) {
      if (ipMatchesCidr(ip, entry.ip) && entry.expiresAt > now) {
        return entry.reason;
      }
    }

    return null;
  }

  /**
   * Check if an IP is in the allowlist
   */
  isAllowed(ip: string): boolean {
    // Localhost is always allowed
    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
      return true;
    }

    for (const entry of this.store.allowlist) {
      if (ipMatchesCidr(ip, entry.ip)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Block an IP address
   */
  blockIp(params: {
    ip: string;
    reason: string;
    durationMs: number;
    source?: "auto" | "manual";
    eventId?: string;
  }): void {
    const { ip, reason, durationMs, source = "auto", eventId } = params;

    // Don't block if allowlisted
    if (this.isAllowed(ip)) {
      return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMs);

    // Remove existing block for this IP
    this.store.blocklist = this.store.blocklist.filter((e) => e.ip !== ip);

    // Add new block
    this.store.blocklist.push({
      ip,
      reason,
      blockedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      source,
      eventId,
    });

    this.save();

    // Log event
    securityLogger.logIpManagement({
      action: SecurityActions.IP_BLOCKED,
      ip,
      severity: "warn",
      details: {
        reason,
        expiresAt: expiresAt.toISOString(),
        source,
      },
    });

    // Update firewall (async, fire-and-forget)
    const firewall = getFirewallManager();
    if (firewall?.isEnabled()) {
      firewall.blockIp(ip, reason).catch((err) => {
        securityLogger.logIpManagement({
          action: "firewall_block_failed",
          ip,
          severity: "critical",
          details: { error: String(err) },
        });
      });
    }
  }

  /**
   * Unblock an IP address
   */
  unblockIp(ip: string): boolean {
    const before = this.store.blocklist.length;
    this.store.blocklist = this.store.blocklist.filter((e) => e.ip !== ip);
    const removed = before !== this.store.blocklist.length;

    if (removed) {
      this.save();

      securityLogger.logIpManagement({
        action: SecurityActions.IP_UNBLOCKED,
        ip,
        severity: "info",
        details: {},
      });

      // Update firewall (async, fire-and-forget)
      const firewall = getFirewallManager();
      if (firewall?.isEnabled()) {
        firewall.unblockIp(ip).catch((err) => {
          securityLogger.logIpManagement({
            action: "firewall_unblock_failed",
            ip,
            severity: "critical",
            details: { error: String(err) },
          });
        });
      }
    }

    return removed;
  }

  /**
   * Add IP to allowlist
   */
  allowIp(params: { ip: string; reason: string; source?: "auto" | "manual" }): void {
    const { ip, reason, source = "manual" } = params;

    // Check if already in allowlist
    const exists = this.store.allowlist.some((e) => e.ip === ip);
    if (exists) return;

    this.store.allowlist.push({
      ip,
      reason,
      addedAt: new Date().toISOString(),
      source,
    });

    this.save();

    securityLogger.logIpManagement({
      action: SecurityActions.IP_ALLOWLISTED,
      ip,
      severity: "info",
      details: { reason, source },
    });
  }

  /**
   * Remove IP from allowlist
   */
  removeFromAllowlist(ip: string): boolean {
    const before = this.store.allowlist.length;
    this.store.allowlist = this.store.allowlist.filter((e) => e.ip !== ip);
    const removed = before !== this.store.allowlist.length;

    if (removed) {
      this.save();

      securityLogger.logIpManagement({
        action: SecurityActions.IP_REMOVED_FROM_ALLOWLIST,
        ip,
        severity: "info",
        details: {},
      });
    }

    return removed;
  }

  /**
   * Get all blocked IPs (non-expired)
   */
  getBlockedIps(): BlocklistEntry[] {
    const now = new Date().toISOString();
    return this.store.blocklist.filter((e) => e.expiresAt > now);
  }

  /**
   * Get all allowlisted IPs
   */
  getAllowedIps(): AllowlistEntry[] {
    return this.store.allowlist;
  }

  /**
   * Get blocklist entry for an IP
   */
  getBlocklistEntry(ip: string): BlocklistEntry | null {
    const now = new Date().toISOString();
    return this.store.blocklist.find((e) => ipMatchesCidr(ip, e.ip) && e.expiresAt > now) ?? null;
  }

  /**
   * Clean up expired blocklist entries
   */
  cleanupExpired(): number {
    const now = new Date().toISOString();
    const before = this.store.blocklist.length;

    this.store.blocklist = this.store.blocklist.filter((e) => e.expiresAt > now);

    const removed = before - this.store.blocklist.length;

    if (removed > 0) {
      this.save();
    }

    return removed;
  }

  /**
   * Save store to disk
   */
  private save(): void {
    saveStore(this.store, this.stateDir);
  }
}

/**
 * Singleton IP manager instance
 */
export const ipManager = new IpManager();

/**
 * Auto-add Tailscale CGNAT range to allowlist
 */
export function ensureTailscaleAllowlist(manager: IpManager = ipManager): void {
  manager.allowIp({
    ip: "100.64.0.0/10",
    reason: "tailscale",
    source: "auto",
  });
}
