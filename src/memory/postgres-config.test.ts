import { describe, expect, it, vi } from "vitest";
import { resolveMemoryBackendConfig } from "./backend-config.js";

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
}));

describe("resolveMemoryBackendConfig postgres", () => {
  it("resolves postgres backend with defaults", () => {
    const result = resolveMemoryBackendConfig({
      cfg: { memory: { backend: "postgres" } } as any,
      agentId: "main",
    });
    expect(result.backend).toBe("postgres");
    expect(result.postgres).toBeDefined();
    expect(result.postgres!.tablePrefix).toBe("openclaw_memory");
    expect(result.postgres!.embedding.provider).toBe("voyage");
    expect(result.postgres!.embedding.model).toBe("voyage-3-lite");
    expect(result.postgres!.embedding.dimensions).toBe(512);
    expect(result.postgres!.hybrid.enabled).toBe(true);
    expect(result.postgres!.hybrid.vectorWeight).toBe(0.7);
    expect(result.postgres!.hybrid.textWeight).toBe(0.3);
    expect(result.qmd).toBeUndefined();
  });

  it("resolves custom postgres config", () => {
    const result = resolveMemoryBackendConfig({
      cfg: {
        memory: {
          backend: "postgres",
          postgres: {
            connectionString: "postgresql://user:pass@host:5432/db",
            tablePrefix: "my_agent",
            embedding: {
              provider: "openai",
              model: "text-embedding-3-small",
              dimensions: 1536,
            },
            hybrid: { enabled: false },
          },
        },
      } as any,
      agentId: "main",
    });
    expect(result.postgres!.connectionString).toBe("postgresql://user:pass@host:5432/db");
    expect(result.postgres!.tablePrefix).toBe("my_agent");
    expect(result.postgres!.embedding.provider).toBe("openai");
    expect(result.postgres!.embedding.dimensions).toBe(1536);
    expect(result.postgres!.hybrid.enabled).toBe(false);
  });

  it("includes default memory collections", () => {
    const result = resolveMemoryBackendConfig({
      cfg: { memory: { backend: "postgres" } } as any,
      agentId: "main",
    });
    expect(result.postgres!.collections.length).toBeGreaterThan(0);
    expect(result.postgres!.collections.some((c) => c.kind === "memory")).toBe(true);
  });

  it("does not return postgres config for qmd backend", () => {
    const result = resolveMemoryBackendConfig({
      cfg: { memory: { backend: "qmd" } } as any,
      agentId: "main",
    });
    expect(result.backend).toBe("qmd");
    expect(result.postgres).toBeUndefined();
  });

  it("does not return postgres config for builtin backend", () => {
    const result = resolveMemoryBackendConfig({
      cfg: { memory: { backend: "builtin" } } as any,
      agentId: "main",
    });
    expect(result.backend).toBe("builtin");
    expect(result.postgres).toBeUndefined();
  });

  it("sanitizes tablePrefix to prevent SQL injection", () => {
    const result = resolveMemoryBackendConfig({
      cfg: {
        memory: {
          backend: "postgres",
          postgres: { tablePrefix: "foo; DROP TABLE users; --" },
        },
      } as any,
      agentId: "main",
    });
    expect(result.postgres!.tablePrefix).toBe("foo__DROP_TABLE_users____");
    expect(result.postgres!.tablePrefix).not.toContain(";");
    expect(result.postgres!.tablePrefix).not.toContain("-");
  });

  it("allows valid tablePrefix characters", () => {
    const result = resolveMemoryBackendConfig({
      cfg: {
        memory: {
          backend: "postgres",
          postgres: { tablePrefix: "my_agent_v2" },
        },
      } as any,
      agentId: "main",
    });
    expect(result.postgres!.tablePrefix).toBe("my_agent_v2");
  });

  it("defaults empty tablePrefix to openclaw_memory", () => {
    const result = resolveMemoryBackendConfig({
      cfg: {
        memory: {
          backend: "postgres",
          postgres: { tablePrefix: "   " },
        },
      } as any,
      agentId: "main",
    });
    expect(result.postgres!.tablePrefix).toBe("openclaw_memory");
  });
});
