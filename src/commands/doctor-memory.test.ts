import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as noteModule from "../terminal/note.js";
import { noteMemorySearchHealth } from "./doctor-memory.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

describe("noteMemorySearchHealth", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should not warn when memory search is explicitly disabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).not.toHaveBeenCalled();
  });

  it("should warn when memory search is enabled with provider=auto but no API keys or local model", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.VOYAGE_API_KEY;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "auto",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).toHaveBeenCalledWith(
      expect.stringContaining("Memory search is enabled but no embeddings provider is configured"),
      "Memory Search",
    );
  });

  it("should not warn when OPENAI_API_KEY is set with provider=auto", () => {
    process.env.OPENAI_API_KEY = "sk-test123";

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "auto",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).not.toHaveBeenCalled();
  });

  it("should not warn when GEMINI_API_KEY is set with provider=auto", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "auto",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).not.toHaveBeenCalled();
  });

  it("should not warn when VOYAGE_API_KEY is set with provider=auto", () => {
    process.env.VOYAGE_API_KEY = "test-voyage-key";

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "auto",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).not.toHaveBeenCalled();
  });

  it("should not warn when local model path is configured with provider=auto", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.VOYAGE_API_KEY;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "auto",
            local: {
              modelPath: "/path/to/model.gguf",
            },
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).not.toHaveBeenCalled();
  });

  it("should warn when provider=openai but OPENAI_API_KEY is missing", () => {
    delete process.env.OPENAI_API_KEY;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "openai",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).toHaveBeenCalledWith(
      expect.stringContaining('provider is set to "openai" but OPENAI_API_KEY is not configured'),
      "Memory Search",
    );
  });

  it("should not warn when provider=openai and OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test123";

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "openai",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).not.toHaveBeenCalled();
  });

  it("should warn when provider=gemini but GEMINI_API_KEY is missing", () => {
    delete process.env.GEMINI_API_KEY;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "gemini",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).toHaveBeenCalledWith(
      expect.stringContaining('provider is set to "gemini" but GEMINI_API_KEY is not configured'),
      "Memory Search",
    );
  });

  it("should warn when provider=voyage but VOYAGE_API_KEY is missing", () => {
    delete process.env.VOYAGE_API_KEY;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "voyage",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).toHaveBeenCalledWith(
      expect.stringContaining('provider is set to "voyage" but VOYAGE_API_KEY is not configured'),
      "Memory Search",
    );
  });

  it("should warn when provider=local but no model path is configured", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "local",
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).toHaveBeenCalledWith(
      expect.stringContaining('provider is set to "local" but no model path is configured'),
      "Memory Search",
    );
  });

  it("should not warn when provider=local and model path is configured", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "local",
            local: {
              modelPath: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
            },
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).not.toHaveBeenCalled();
  });

  it("should warn when memory search is implicitly enabled (no config) and no providers available", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.VOYAGE_API_KEY;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {},
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).toHaveBeenCalledWith(
      expect.stringContaining("Memory search is enabled but no embeddings provider is configured"),
      "Memory Search",
    );
  });

  it("should not warn when empty local model path (treated as not configured)", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.VOYAGE_API_KEY;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "auto",
            local: {
              modelPath: "  ", // whitespace only
            },
          },
        },
      },
    };

    noteMemorySearchHealth(cfg);

    expect(noteModule.note).toHaveBeenCalledWith(
      expect.stringContaining("Memory search is enabled but no embeddings provider is configured"),
      "Memory Search",
    );
  });
});
