import { describe, it, expect } from "vitest";
import { validateConfigObject } from "./config.js";

describe("validateConfigObject - memorySearch", () => {
  it("accepts valid openai configuration", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            remote: {
              apiKey: "sk-test-key",
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts valid ollama configuration with baseUrl", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            model: "nomic-embed-text",
            remote: {
              baseUrl: "http://localhost:11434",
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts ollama without baseUrl (uses default localhost)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            model: "nomic-embed-text",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts ollama without model (uses provider default)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            remote: {
              baseUrl: "http://localhost:11434",
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts valid local configuration", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts configuration without provider (uses default)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {},
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts openai without explicit model (uses provider default)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            remote: {
              apiKey: "sk-test-key",
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts openai provider without apiKey (resolved at runtime)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts openai provider without apiKey and model (resolved at runtime)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts gemini provider without apiKey (resolved at runtime)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-001",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts gemini without explicit model (uses provider default)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            remote: {
              apiKey: "test-key",
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts voyage provider without apiKey (resolved at runtime)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "voyage",
            model: "voyage-3",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts voyage without explicit model (uses provider default)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "voyage",
            remote: {
              apiKey: "test-key",
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts mistral provider without apiKey (resolved at runtime)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "mistral",
            model: "mistral-embed",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts mistral without explicit model (uses provider default)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "mistral",
            remote: {
              apiKey: "test-key",
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("skips validation when memory backend is qmd", () => {
    const result = validateConfigObject({
      memory: {
        backend: "qmd",
      },
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            // No apiKey - should be OK because qmd handles embeddings internally
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects ollama provider when baseUrl is an empty string", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            remote: {
              baseUrl: "",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain("non-empty baseUrl");
  });

  it("rejects ollama provider when baseUrl is whitespace only", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            remote: {
              baseUrl: "   ",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain("non-empty baseUrl");
  });

  it("accepts per-agent memorySearch configurations (can inherit from defaults)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            remote: {
              apiKey: "sk-test-key",
            },
          },
        },
        list: [
          {
            id: "agent-1",
            memorySearch: {
              provider: "ollama",
              // Missing baseUrl - should be OK because can inherit from defaults
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts valid per-agent memorySearch configurations", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            remote: {
              apiKey: "sk-test-key",
            },
          },
        },
        list: [
          {
            id: "agent-1",
            memorySearch: {
              provider: "ollama",
              model: "nomic-embed-text",
              remote: {
                baseUrl: "http://localhost:11434",
              },
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("validates multiple per-agent memorySearch configurations (empty baseUrl still rejected)", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            remote: {
              apiKey: "sk-test-key",
            },
          },
        },
        list: [
          {
            id: "agent-1",
            memorySearch: {
              provider: "ollama",
              // Missing baseUrl - OK (can inherit from defaults)
            },
          },
          {
            id: "agent-2",
            memorySearch: {
              provider: "ollama",
              remote: {
                baseUrl: "", // Empty baseUrl - should be caught
              },
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe("agents.list[1].memorySearch");
  });
});
