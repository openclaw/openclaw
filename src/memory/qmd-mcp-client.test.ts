/**
 * Tests for QmdMcpClient
 *
 * Unit tests for the MCP client wrapper for QMD.
 * These tests focus on the result parsing logic which doesn't require
 * spawning actual processes.
 */

import { describe, it, expect } from "vitest";
import { QmdMcpClient, type QmdMcpConfig } from "./qmd-mcp-client.js";

describe("QmdMcpClient", () => {
  // Filter undefined values from process.env to match Record<string, string>
  const filteredEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      filteredEnv[key] = value;
    }
  }

  const defaultConfig: Partial<QmdMcpConfig> & Pick<QmdMcpConfig, "command" | "env" | "cwd"> = {
    command: "qmd",
    env: filteredEnv,
    cwd: "/tmp/test",
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    maxRetries: 2,
    retryDelayMs: 100,
  };

  describe("lifecycle", () => {
    it("starts in stopped state", () => {
      const client = new QmdMcpClient(defaultConfig);
      expect(client.getState()).toBe("stopped");
      expect(client.isRunning()).toBe(false);
    });
  });

  describe("configuration", () => {
    it("uses default values for optional config", () => {
      const client = new QmdMcpClient({
        command: "qmd",
        env: {},
        cwd: "/tmp",
      });
      expect(client.getState()).toBe("stopped");
    });

    it("accepts custom timeout values", () => {
      const client = new QmdMcpClient({
        ...defaultConfig,
        startupTimeoutMs: 5000,
        requestTimeoutMs: 10000,
      });
      expect(client.getState()).toBe("stopped");
    });
  });

  describe("isFailed", () => {
    it("returns false when not started", () => {
      const client = new QmdMcpClient(defaultConfig);
      expect(client.isFailed()).toBe(false);
    });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("QmdMcpClient result parsing", () => {
  // These tests verify the result parsing logic works correctly
  // without needing to actually spawn a QMD process
  // Note: Using 'any' to access private methods for testing

  it("handles empty search results", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    // Access private method through prototype for testing
    const extractSearchResults = (client as any).extractSearchResults.bind(client);

    // Test with empty structuredContent
    expect(extractSearchResults({ structuredContent: { results: [] } })).toEqual([]);

    // Test with null/undefined
    expect(extractSearchResults(null)).toEqual([]);
    expect(extractSearchResults(undefined)).toEqual([]);
    expect(extractSearchResults({})).toEqual([]);
  });

  it("normalizes search result fields", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    const extractSearchResults = (client as any).extractSearchResults.bind(client);

    const result = extractSearchResults({
      structuredContent: {
        results: [
          {
            docid: "#abc123",
            file: "test.md",
            title: "Test Document",
            score: 0.95,
            snippet: "Test snippet...",
          },
        ],
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      docid: "#abc123",
      file: "test.md",
      title: "Test Document",
      score: 0.95,
      context: null,
      snippet: "Test snippet...",
      body: undefined,
    });
  });

  it("handles missing optional fields in results", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    const extractSearchResults = (client as any).extractSearchResults.bind(client);

    const result = extractSearchResults({
      structuredContent: {
        results: [
          {
            docid: "#abc123",
            file: "test.md",
            score: 0.5,
          },
        ],
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBeUndefined();
    expect(result[0].snippet).toBeUndefined();
    expect(result[0].context).toBeNull();
  });

  it("extracts document from structuredContent", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    const extractDocument = (client as any).extractDocument.bind(client);

    const doc = extractDocument({
      structuredContent: {
        document: {
          docid: "#abc123",
          file: "test.md",
          title: "Test",
          content: "Document content here",
        },
      },
    });

    expect(doc).toEqual({
      docid: "#abc123",
      file: "test.md",
      title: "Test",
      content: "Document content here",
    });
  });

  it("falls back to text content for documents", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    const extractDocument = (client as any).extractDocument.bind(client);

    const doc = extractDocument({
      content: [{ type: "text", text: "Fallback content" }],
    });

    expect(doc).toEqual({
      docid: "",
      file: "",
      content: "Fallback content",
    });
  });

  it("returns null for invalid document response", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    const extractDocument = (client as any).extractDocument.bind(client);

    expect(extractDocument(null)).toBeNull();
    expect(extractDocument(undefined)).toBeNull();
    expect(extractDocument({})).toBeNull();
    expect(extractDocument({ content: [] })).toBeNull();
  });

  it("handles results from text content fallback", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    const extractSearchResults = (client as any).extractSearchResults.bind(client);

    // Test JSON in text content
    const result = extractSearchResults({
      content: [
        {
          type: "text",
          text: JSON.stringify([{ docid: "#abc", file: "test.md", score: 0.8 }]),
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0].docid).toBe("#abc");
  });

  it("handles non-JSON text content gracefully", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    const extractSearchResults = (client as any).extractSearchResults.bind(client);

    // Non-JSON text should return empty array
    const result = extractSearchResults({
      content: [{ type: "text", text: "Not valid JSON" }],
    });

    expect(result).toEqual([]);
  });

  it("handles body field in search results", async () => {
    const client = new QmdMcpClient({
      command: "qmd",
      env: {},
      cwd: "/tmp",
    });

    const extractSearchResults = (client as any).extractSearchResults.bind(client);

    const result = extractSearchResults({
      structuredContent: {
        results: [
          {
            docid: "#abc123",
            file: "test.md",
            score: 0.5,
            body: "Full document body here",
          },
        ],
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("Full document body here");
  });
});
