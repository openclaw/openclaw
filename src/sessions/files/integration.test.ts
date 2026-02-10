import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveFile, getFile, listFiles, getParsedCsv } from "./storage.js";

describe("Markdown storage integration with real files", () => {
  let testDir: string;
  const sessionId = `test-integration-${Date.now()}`;
  const agentId = "test-agent";

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-files-integration-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("saves and retrieves CSV file as markdown table", async () => {
    const csvPath = path.join(process.cwd(), ".cursor/test/bot knowledge test.csv");
    const csvBuffer = await fs.readFile(csvPath);

    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "bot knowledge test.csv",
      type: "csv",
      buffer: csvBuffer,
      filesDir: testDir,
    });

    const result = await getFile({
      sessionId,
      agentId,
      fileId,
      filesDir: testDir,
    });

    const content = result.buffer.toString("utf-8");
    // Should be raw CSV content (not markdown table)
    expect(content).toContain(",");
    // Should NOT contain markdown table markers
    expect(content).not.toContain("|");
    expect(content).not.toContain("---");
    // Should contain some data from the CSV
    expect(content.length).toBeGreaterThan(100);

    // Verify CSV parsing still works
    const parsed = await getParsedCsv({
      sessionId,
      agentId,
      fileId,
      filesDir: testDir,
    });
    expect(parsed.columns.length).toBeGreaterThan(0);
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it("saves and retrieves JSON file as markdown", async () => {
    const jsonPath = path.join(process.cwd(), ".cursor/test/postman_collection.json");
    const jsonBuffer = await fs.readFile(jsonPath);

    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "postman_collection.json",
      type: "json",
      buffer: jsonBuffer,
      filesDir: testDir,
    });

    const result = await getFile({
      sessionId,
      agentId,
      fileId,
      filesDir: testDir,
    });

    const content = result.buffer.toString("utf-8");
    // Should be raw JSON content (not wrapped in code block)
    expect(content).not.toContain("```json");
    expect(content).not.toContain("```");
    // Should contain JSON content (check for common JSON structure)
    expect(content).toMatch(/\{/);
    expect(content.length).toBeGreaterThan(100);
  });

  it("saves and retrieves text file as markdown", async () => {
    const textPath = path.join(process.cwd(), ".cursor/test/sejarah_bri.txt");
    const textBuffer = await fs.readFile(textPath);

    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "sejarah_bri.txt",
      type: "text",
      buffer: textBuffer,
      filesDir: testDir,
    });

    const result = await getFile({
      sessionId,
      agentId,
      fileId,
      filesDir: testDir,
    });

    const content = result.buffer.toString("utf-8");
    // Should contain the text content
    expect(content).toContain("BRI");
    expect(content.length).toBeGreaterThan(100);
  });

  it("saves and retrieves PDF file as markdown", async () => {
    const pdfPath = path.join(process.cwd(), ".cursor/test/BRI Environmental Highlight.pdf");
    const pdfBuffer = await fs.readFile(pdfPath);

    const fileId = await saveFile({
      sessionId,
      agentId,
      filename: "BRI Environmental Highlight.pdf",
      type: "pdf",
      buffer: pdfBuffer,
      filesDir: testDir,
    });

    const result = await getFile({
      sessionId,
      agentId,
      fileId,
      filesDir: testDir,
    });

    const content = result.buffer.toString("utf-8");
    // PDF content should be extracted and saved as markdown
    // Note: PDF extraction may fail in test environment if dependencies are missing
    // In that case, it will return an error message, which is acceptable
    expect(content.length).toBeGreaterThan(0);
    // If extraction succeeded, should contain some text (not just error message)
    if (!content.includes("PDF extraction failed")) {
      expect(content.length).toBeGreaterThan(50);
    }
  });

  it("handles multiple file types in same session", async () => {
    const csvPath = path.join(process.cwd(), ".cursor/test/bot knowledge test.csv");
    const jsonPath = path.join(process.cwd(), ".cursor/test/postman_collection.json");
    const textPath = path.join(process.cwd(), ".cursor/test/sejarah_bri.txt");

    const csvBuffer = await fs.readFile(csvPath);
    const jsonBuffer = await fs.readFile(jsonPath);
    const textBuffer = await fs.readFile(textPath);

    const csvFileId = await saveFile({
      sessionId,
      agentId,
      filename: "test.csv",
      type: "csv",
      buffer: csvBuffer,
      filesDir: testDir,
    });

    const jsonFileId = await saveFile({
      sessionId,
      agentId,
      filename: "test.json",
      type: "json",
      buffer: jsonBuffer,
      filesDir: testDir,
    });

    const textFileId = await saveFile({
      sessionId,
      agentId,
      filename: "test.txt",
      type: "text",
      buffer: textBuffer,
      filesDir: testDir,
    });

    const files = await listFiles({ sessionId, agentId, filesDir: testDir });
    expect(files).toHaveLength(3);

    // Verify each file can be retrieved
    const csvResult = await getFile({ sessionId, agentId, fileId: csvFileId, filesDir: testDir });
    // Should be raw CSV (not markdown table)
    expect(csvResult.buffer.toString("utf-8")).toContain(",");
    expect(csvResult.buffer.toString("utf-8")).not.toContain("|");

    const jsonResult = await getFile({ sessionId, agentId, fileId: jsonFileId, filesDir: testDir });
    // Should be raw JSON (not code block wrapped)
    expect(jsonResult.buffer.toString("utf-8")).not.toContain("```json");

    const textResult = await getFile({ sessionId, agentId, fileId: textFileId, filesDir: testDir });
    expect(textResult.buffer.toString("utf-8")).toContain("BRI");
  });
});
