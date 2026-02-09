import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupExpiredFiles } from "./cleanup.js";
import { queryCsv } from "./csv-query.js";
import { searchText } from "./pdf-search.js";
import { saveFile, getFile, listFiles, deleteFile, getParsedCsv } from "./storage.js";

describe("session files e2e", () => {
  let testDir: string;
  const sessionId = "e2e-session";
  const agentId = "e2e-agent";

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-files-e2e-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("full flow: save CSV, list, query, delete", async () => {
    // 1. Save CSV file
    const csvContent =
      "name,sales,region\nProduct A,1000,North\nProduct B,2000,South\nProduct C,1500,North";
    const csvBuffer = Buffer.from(csvContent);
    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "sales.csv",
      type: "csv",
      buffer: csvBuffer,
      filesDir: testDir,
    });
    expect(fileId).toBeTruthy();

    // 2. List files
    const files = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe(fileId);
    expect(files[0].filename).toBe("sales.csv");
    expect(files[0].type).toBe("csv");
    expect(files[0].csvSchema?.columns).toEqual(["name", "sales", "region"]);

    // 3. Query CSV - filter by column
    const parsed = await getParsedCsv({ sessionId, agentId, fileId, filesDir: testDir });
    const filtered = queryCsv({
      rows: parsed.rows,
      columns: parsed.columns,
      filter: { column: "region", operator: "eq", value: "North" },
    });
    expect(filtered.total).toBe(2);
    expect(filtered.rows).toHaveLength(2);
    expect(filtered.rows[0].name).toBe("Product A");
    expect(filtered.rows[1].name).toBe("Product C");

    // 4. Query CSV - limit and select columns
    const limited = queryCsv({
      rows: parsed.rows,
      columns: parsed.columns,
      limit: 2,
      selectColumns: ["name", "sales"],
    });
    expect(limited.rows).toHaveLength(2);
    expect(limited.columns).toEqual(["name", "sales"]);
    expect(limited.rows[0]).toEqual({ name: "Product A", sales: 1000 });

    // 5. Delete file
    await deleteFile({ sessionId, agentId, fileId, filesDir: testDir });
    const filesAfterDelete = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(filesAfterDelete).toHaveLength(0);
  });

  it("full flow: save PDF/text, search, delete", async () => {
    // 1. Save text file (simulating PDF text extraction)
    const textContent = `Chapter 1: Introduction
This document describes the system architecture.
The system has three main components: frontend, backend, and database.

Chapter 2: Frontend
The frontend is built with React and TypeScript.
It communicates with the backend via REST API.

Chapter 3: Backend
The backend uses Node.js and Express.
It handles authentication and business logic.`;
    const textBuffer = Buffer.from(textContent);
    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "document.txt",
      type: "text",
      buffer: textBuffer,
      filesDir: testDir,
    });
    expect(fileId).toBeTruthy();

    // 2. List files
    const files = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("text");

    // 3. Search text - single token
    const matches1 = searchText(textContent, "frontend");
    expect(matches1.length).toBeGreaterThan(0);
    expect(matches1[0].snippet).toContain("frontend");

    // 4. Search text - multiple tokens (all must match)
    const matches2 = searchText(textContent, "backend REST");
    expect(matches2.length).toBeGreaterThan(0);
    const allMatch = matches2.every(
      (m) =>
        m.context.toLowerCase().includes("backend") && m.context.toLowerCase().includes("rest"),
    );
    expect(allMatch).toBe(true);

    // 5. Get file content
    const { buffer, metadata } = await getFile({ sessionId, agentId, fileId, filesDir: testDir });
    expect(buffer.toString()).toBe(textContent);
    expect(metadata.filename).toBe("document.txt");

    // 6. Delete file
    await deleteFile({ sessionId, agentId, fileId, filesDir: testDir });
    const filesAfterDelete = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(filesAfterDelete).toHaveLength(0);
  });

  it("full flow: multiple files, cleanup expired", async () => {
    const now = Date.now();
    const expiredTime = now - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    const validTime = now + 3 * 24 * 60 * 60 * 1000; // 3 days from now

    // Save expired file
    const expiredFileId = await saveFile({
      sessionId,
      agentId,
      filename: "expired.txt",
      type: "text",
      buffer: Buffer.from("expired content"),
      filesDir: testDir,
    });

    // Manually set expired timestamp
    const indexPath = path.join(testDir, "index.json");
    const indexContent = await fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(indexContent);
    const expiredFile = index.files.find((f: { id: string }) => f.id === expiredFileId);
    if (expiredFile) {
      expiredFile.expiresAt = expiredTime;
      await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
    }

    // Save valid file
    const validFileId = await saveFile({
      sessionId,
      agentId,
      filename: "valid.csv",
      type: "csv",
      buffer: Buffer.from("a,b\n1,2"),
      filesDir: testDir,
    });

    // Manually set valid timestamp
    const indexContent2 = await fs.readFile(indexPath, "utf-8");
    const index2 = JSON.parse(indexContent2);
    const validFile = index2.files.find((f: { id: string }) => f.id === validFileId);
    if (validFile) {
      validFile.expiresAt = validTime;
      await fs.writeFile(indexPath, JSON.stringify(index2, null, 2));
    }

    // Verify both files exist
    const filesBefore = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(filesBefore.length).toBeGreaterThanOrEqual(2);

    // Run cleanup
    const result = await cleanupExpiredFiles({ sessionId, agentId, filesDir: testDir });
    expect(result.deleted).toBeGreaterThan(0);

    // Verify expired file is deleted, valid file remains
    const filesAfter = await listFiles({ sessionId, agentId, filesDir: testDir });
    const expiredStillExists = filesAfter.some((f) => f.id === expiredFileId);
    const validStillExists = filesAfter.some((f) => f.id === validFileId);
    expect(expiredStillExists).toBe(false);
    expect(validStillExists).toBe(true);
  });

  it("full flow: CSV with numeric filtering", async () => {
    const csvContent = "id,price,quantity\n1,100,5\n2,200,10\n3,150,8\n4,300,12";
    const csvBuffer = Buffer.from(csvContent);
    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "products.csv",
      type: "csv",
      buffer: csvBuffer,
      filesDir: testDir,
    });

    const parsed = await getParsedCsv({ sessionId, agentId, fileId, filesDir: testDir });

    // Test numeric comparisons
    const gtResult = queryCsv({
      rows: parsed.rows,
      columns: parsed.columns,
      filter: { column: "price", operator: "gt", value: 150 },
    });
    expect(gtResult.total).toBe(2);
    expect(gtResult.rows.every((r) => (r.price as number) > 150)).toBe(true);

    const lteResult = queryCsv({
      rows: parsed.rows,
      columns: parsed.columns,
      filter: { column: "quantity", operator: "lte", value: 8 },
    });
    expect(lteResult.total).toBe(2);
    expect(lteResult.rows.every((r) => (r.quantity as number) <= 8)).toBe(true);
  });
});
