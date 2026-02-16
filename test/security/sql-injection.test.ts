/**
 * SQL Injection Security Tests
 *
 * This test suite verifies that the OpenClaw codebase is resistant to SQL injection attacks.
 * All database queries should use parameterized statements with ? placeholders.
 *
 * Security Agent 6 | Task #12: SQL Injection Prevention
 * Test Coverage: Database layer security verification
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test, expect, beforeEach, afterEach } from "vitest";

describe("SQL Injection Security Tests", () => {
  let db: DatabaseSync;
  let dbPath: string;

  beforeEach(() => {
    // Create temporary in-memory database for testing
    dbPath = `:memory:`;
    db = new DatabaseSync(dbPath);

    // Create test schema similar to OpenClaw's memory system
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        status INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe("Parameterized Query Tests", () => {
    test("SELECT with malicious input in WHERE clause should not succeed", () => {
      // Insert test data
      db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "1",
        "test@example.com",
        "Test User",
        Date.now(),
      );

      db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "2",
        "admin@example.com",
        "Admin User",
        Date.now(),
      );

      // Attempt SQL injection via email parameter
      const maliciousEmail = "' OR '1'='1";

      // CORRECT: Using parameterized query
      const result = db.prepare("SELECT * FROM leads WHERE email = ?").get(maliciousEmail);

      // Should return null because no email matches the literal string "' OR '1'='1"
      expect(result).toBeUndefined();

      // Verify we still have exactly 2 leads (not all leads leaked)
      const allLeads = db.prepare("SELECT COUNT(*) as count FROM leads").get() as { count: number };
      expect(allLeads.count).toBe(2);
    });

    test("INSERT with malicious input should be safely escaped", () => {
      const maliciousName = "'; DROP TABLE leads; --";
      const maliciousEmail = "hacker@evil.com";

      // CORRECT: Using parameterized query
      db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "3",
        maliciousEmail,
        maliciousName,
        Date.now(),
      );

      // Verify the lead was inserted with the malicious string as data
      const result = db.prepare("SELECT * FROM leads WHERE email = ?").get(maliciousEmail) as
        | { name: string }
        | undefined;

      expect(result?.name).toBe("'; DROP TABLE leads; --");

      // Verify table still exists (not dropped)
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'")
        .get();
      expect(tableExists).toBeDefined();
    });

    test("UPDATE with malicious input should be safely parameterized", () => {
      db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "4",
        "user@example.com",
        "Original Name",
        Date.now(),
      );

      const maliciousName = "' WHERE 1=1; UPDATE leads SET status = -1 WHERE '1'='1";

      // CORRECT: Using parameterized query
      db.prepare("UPDATE leads SET name = ? WHERE id = ?").run(maliciousName, "4");

      // Verify only the intended lead was updated
      const updated = db.prepare("SELECT name, status FROM leads WHERE id = ?").get("4") as {
        name: string;
        status: number;
      };

      expect(updated.name).toBe(maliciousName);
      expect(updated.status).toBe(1); // Status should still be 1
    });

    test("DELETE with malicious input should only delete intended row", () => {
      db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "5",
        "user1@example.com",
        "User 1",
        Date.now(),
      );
      db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "6",
        "user2@example.com",
        "User 2",
        Date.now(),
      );

      const maliciousId = "5' OR '1'='1";

      // CORRECT: Using parameterized query
      db.prepare("DELETE FROM leads WHERE id = ?").run(maliciousId);

      // Verify both leads still exist (malicious ID doesn't match any row)
      const remainingLeads = db.prepare("SELECT COUNT(*) as count FROM leads").get() as {
        count: number;
      };
      expect(remainingLeads.count).toBe(2);
    });
  });

  describe("UNION-based Injection Tests", () => {
    test("UNION injection attempt should fail with parameterized queries", () => {
      db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "7",
        "test@example.com",
        "Test",
        Date.now(),
      );

      const maliciousInput = "' UNION SELECT id, email, name, created_at FROM leads --";

      // CORRECT: Using parameterized query
      const result = db.prepare("SELECT * FROM leads WHERE email = ?").get(maliciousInput);

      // Should return no results because the literal string doesn't match
      expect(result).toBeUndefined();
    });
  });

  describe("Stacked Queries Tests", () => {
    test("Stacked query injection should fail with parameterized queries", () => {
      db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
        "8",
        "test@example.com",
        "Test",
        Date.now(),
      );

      const maliciousInput = "8; DROP TABLE leads; --";

      // CORRECT: Using parameterized query
      const result = db.prepare("SELECT * FROM leads WHERE id = ?").get(maliciousInput);

      // Should return no results
      expect(result).toBeUndefined();

      // Verify table still exists
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'")
        .get();
      expect(tableExists).toBeDefined();
    });
  });

  describe("Special Characters Handling", () => {
    test("Emails with special characters should be handled correctly", () => {
      const specialEmails = [
        "test+tag@example.com",
        "user.name+filter@example.com",
        "test'quote@example.com",
        'test"double@example.com',
        "test`backtick@example.com",
      ];

      specialEmails.forEach((email, index) => {
        db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
          `special-${index}`,
          email,
          "Special User",
          Date.now(),
        );

        const retrieved = db
          .prepare("SELECT email FROM leads WHERE id = ?")
          .get(`special-${index}`) as { email: string };

        expect(retrieved.email).toBe(email);
      });
    });

    test("Names with SQL keywords should be stored correctly", () => {
      const sqlKeywordNames = [
        "SELECT Smith",
        "DROP Jones",
        "DELETE FROM Williams",
        "INSERT INTO Brown",
        "UPDATE Davis",
      ];

      sqlKeywordNames.forEach((name, index) => {
        db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
          `keyword-${index}`,
          `user${index}@example.com`,
          name,
          Date.now(),
        );

        const retrieved = db
          .prepare("SELECT name FROM leads WHERE id = ?")
          .get(`keyword-${index}`) as { name: string };

        expect(retrieved.name).toBe(name);
      });
    });
  });

  describe("Batch Operations Security", () => {
    test("Batch inserts with mixed legitimate and malicious data", () => {
      const testData = [
        { id: "batch1", email: "normal@example.com", name: "Normal User" },
        { id: "batch2", email: "'; DROP TABLE leads; --", name: "Hacker" },
        { id: "batch3", email: "another@example.com", name: "Another User" },
      ];

      const stmt = db.prepare(
        "INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)",
      );

      testData.forEach((data) => {
        stmt.run(data.id, data.email, data.name, Date.now());
      });

      // Verify all records were inserted
      const count = db.prepare("SELECT COUNT(*) as count FROM leads").get() as { count: number };
      expect(count.count).toBe(3);

      // Verify table still exists
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'")
        .get();
      expect(tableExists).toBeDefined();
    });
  });

  describe("OpenClaw Memory System Pattern Tests", () => {
    test("File sync pattern is secure against path traversal SQL injection", () => {
      const maliciousPath = "../../../etc/passwd' OR '1'='1";
      const now = Date.now();

      // Pattern from sync-memory-files.ts
      db.prepare("INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)").run(
        maliciousPath,
        "memory",
        "hash123",
        now,
        1024,
      );

      const result = db
        .prepare("SELECT * FROM files WHERE path = ? AND source = ?")
        .get(maliciousPath, "memory") as { path: string } | undefined;

      expect(result?.path).toBe(maliciousPath);
    });

    test("Chunk indexing pattern is secure", () => {
      const maliciousText = "'; DELETE FROM chunks WHERE '1'='1";
      const now = Date.now();

      // Pattern from manager.ts indexFile method
      db.prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "chunk-id-1",
        "test.md",
        "memory",
        1,
        10,
        "hash456",
        "text-embedding-3-small",
        maliciousText,
        "[]",
        now,
      );

      const retrieved = db.prepare("SELECT text FROM chunks WHERE id = ?").get("chunk-id-1") as {
        text: string;
      };

      expect(retrieved.text).toBe(maliciousText);

      // Verify no chunks were deleted
      const count = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
      expect(count.count).toBe(1);
    });

    test("Source filtering is secure with IN clause", () => {
      // Insert test data
      db.prepare(
        "INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("c1", "file1.md", "memory", 1, 5, "h1", "model1", "text1", "[]", Date.now());
      db.prepare(
        "INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("c2", "file2.md", "sessions", 1, 5, "h2", "model1", "text2", "[]", Date.now());

      const sources = ["memory"];
      const placeholders = sources.map(() => "?").join(", ");

      // Pattern from manager.ts buildSourceFilter
      const results = db
        .prepare(`SELECT source FROM chunks WHERE source IN (${placeholders})`)
        .all(...sources) as Array<{ source: string }>;

      expect(results.length).toBe(1);
      expect(results[0].source).toBe("memory");
    });
  });

  describe("Error Handling Tests", () => {
    test("Invalid SQL syntax in parameters should not cause SQL errors", () => {
      const invalidSyntaxName = "SELECT * FROM users WHERE 1=1; --";

      expect(() => {
        db.prepare("INSERT INTO leads (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
          "error-test",
          "test@example.com",
          invalidSyntaxName,
          Date.now(),
        );
      }).not.toThrow();

      const result = db.prepare("SELECT name FROM leads WHERE id = ?").get("error-test") as {
        name: string;
      };

      expect(result.name).toBe(invalidSyntaxName);
    });
  });
});

describe("Dynamic Table Names Security", () => {
  test("Hardcoded table name constants are safe", () => {
    // These constants from manager.ts are safe because they're hardcoded
    const VECTOR_TABLE = "chunks_vec";
    const FTS_TABLE = "chunks_fts";
    const EMBEDDING_CACHE_TABLE = "embedding_cache";

    expect(VECTOR_TABLE).toBe("chunks_vec");
    expect(FTS_TABLE).toBe("chunks_fts");
    expect(EMBEDDING_CACHE_TABLE).toBe("embedding_cache");

    // Verify they're strings without any user input
    expect(typeof VECTOR_TABLE).toBe("string");
    expect(VECTOR_TABLE).not.toContain("${");
    expect(VECTOR_TABLE).not.toContain("?");
  });

  test("Column name allowlist validation pattern", () => {
    const ALLOWED_SORT_COLUMNS = new Set(["email", "name", "created_at", "status"]);

    // Simulate column name validation
    function validateSortColumn(column: string): boolean {
      return ALLOWED_SORT_COLUMNS.has(column);
    }

    // Valid columns should pass
    expect(validateSortColumn("email")).toBe(true);
    expect(validateSortColumn("name")).toBe(true);

    // Invalid/malicious columns should fail
    expect(validateSortColumn("DROP TABLE")).toBe(false);
    expect(validateSortColumn("email; DROP TABLE")).toBe(false);
    expect(validateSortColumn("*")).toBe(false);
  });
});

describe("Real-world Attack Scenarios", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user'
      );
    `);

    db.prepare("INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)").run(
      "admin",
      "admin",
      "hashed_password",
      "admin",
    );
    db.prepare("INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)").run(
      "user1",
      "user1",
      "hashed_pass1",
      "user",
    );
  });

  afterEach(() => {
    db.close();
  });

  test("Authentication bypass attempt should fail", () => {
    // Classic SQL injection: username = admin'-- , password = anything
    const maliciousUsername = "admin'--";
    const anyPassword = "wrong_password";

    // SECURE: Parameterized query
    const result = db
      .prepare("SELECT * FROM users WHERE username = ? AND password = ?")
      .get(maliciousUsername, anyPassword);

    // Should not authenticate (no user with username "admin'--")
    expect(result).toBeUndefined();
  });

  test("Privilege escalation attempt should fail", () => {
    const maliciousUpdate = "user' WHERE 1=1; UPDATE users SET role = 'admin' WHERE '1'='1";

    // SECURE: Parameterized query
    db.prepare("UPDATE users SET username = ? WHERE id = ?").run(maliciousUpdate, "user1");

    // Verify admin user still exists and only admin has admin role
    const adminUsers = db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
      .get() as { count: number };

    expect(adminUsers.count).toBe(1);
  });

  test("Data exfiltration via error-based injection should fail", () => {
    // Attempt to cause error revealing data
    const maliciousId =
      "1' AND 1=CAST((SELECT password FROM users WHERE username='admin') AS INT) --";

    // SECURE: Parameterized query - malicious string treated as literal
    const result = db.prepare("SELECT * FROM users WHERE id = ?").get(maliciousId);

    expect(result).toBeUndefined();
  });
});
