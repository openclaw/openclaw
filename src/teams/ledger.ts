/**
 * SQLite Ledger for Team State
 * Manages SQLite database operations for team state persistence
 * Based on OpenClaw Agent Teams Design (2026-02-23)
 */

import { mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "path";

/**
 * SQLite Ledger class for team state management
 */
export class TeamLedger {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;

  constructor(teamName: string, stateDir: string) {
    this.dbPath = join(stateDir, teamName, "ledger.db");
    const dbDir = join(stateDir, teamName);
    mkdirSync(dbDir, { recursive: true });
  }

  /**
   * Open database connection with WAL mode
   */
  openDatabase(): void {
    if (this.db) {
      return;
    }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
    this.ensureSchema();
  }

  /**
   * Ensure all required tables exist
   */
  private ensureSchema(): void {
    if (!this.db) {
      throw new Error("Database not opened");
    }

    // Tasks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        activeForm TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'in_progress', 'completed', 'failed')),
        owner TEXT,
        dependsOn TEXT,
        blockedBy TEXT,
        blocks TEXT,
        metadata TEXT,
        createdAt INTEGER NOT NULL,
        claimedAt INTEGER,
        completedAt INTEGER
      )
    `);

    // Create indexes on tasks table
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(createdAt)`);

    // Members table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS members (
        sessionKey TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        name TEXT,
        role TEXT CHECK(role IN ('lead', 'member')),
        agentType TEXT,
        status TEXT CHECK(status IN ('idle', 'working', 'blocked')),
        currentTask TEXT,
        joinedAt INTEGER NOT NULL,
        lastActiveAt INTEGER
      )
    `);

    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        fromSession TEXT NOT NULL,
        toSession TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('message', 'broadcast', 'shutdown_request', 'shutdown_response', 'idle')),
        content TEXT NOT NULL,
        summary TEXT,
        requestId TEXT,
        approve INTEGER,
        reason TEXT,
        createdAt INTEGER NOT NULL,
        delivered INTEGER DEFAULT 0
      )
    `);
  }

  /**
   * Get the database instance (for internal use by TeamManager)
   */
  getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("Database not opened");
    }
    return this.db;
  }

  /**
   * Check if database is open
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
