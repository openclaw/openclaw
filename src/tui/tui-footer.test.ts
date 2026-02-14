import { describe, expect, it } from "vitest";
import { formatFooter, type FooterState } from "./tui-footer.js";
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;

function plain(state: FooterState): string {
  return formatFooter(state).replace(ANSI_RE, "");
}

describe("tui-footer", () => {
  it("displays full info correctly", () => {
    const result = plain({
      model: "ollama/gemma3:4b",
      tokPerSec: 42.3,
      totalTokens: 1200,
      contextTokens: 8000,
      connectivityStatus: "local-only",
      ollamaHealthy: true,
    });
    expect(result).toContain("🌿 ollama/gemma3:4b");
    expect(result).toContain("42.3 t/s");
    expect(result).toContain("tokens 1.2k/8.0k (15%)");
    expect(result).toContain("local-only");
  });

  it("shows — when tok/s is missing", () => {
    const result = plain({
      model: "ollama/llama3",
      connectivityStatus: "online",
      ollamaHealthy: true,
    });
    expect(result).toContain("— t/s");
  });

  it("calculates token percentage correctly", () => {
    const result = plain({
      model: "m",
      tokPerSec: 10,
      totalTokens: 4000,
      contextTokens: 8000,
      connectivityStatus: "online",
      ollamaHealthy: true,
    });
    expect(result).toContain("(50%)");
  });

  it("shows connectivity status variations", () => {
    for (const status of ["online", "local-only"]) {
      const result = plain({
        model: "m",
        connectivityStatus: status,
        ollamaHealthy: true,
      });
      expect(result).toContain(status);
    }
  });

  it("shows warning when ollama is unhealthy", () => {
    const result = plain({
      model: "m",
      connectivityStatus: "no-ollama",
      ollamaHealthy: false,
    });
    expect(result).toContain("⚠ no-ollama");
    expect(result).not.toContain("online");
  });
});
